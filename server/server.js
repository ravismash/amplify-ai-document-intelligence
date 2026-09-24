import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildGroundingPrompt, isNotFoundResponse } from './prompt.js';
import * as objectStore from './storage/objectStore.js';
import * as documentsDb from './db/documents.js';
import * as extractionsDb from './db/extractions.js';
import * as chunksDb from './db/chunks.js';
import * as queriesDb from './db/queries.js';
import * as reportsDb from './db/reports.js';
import { getPool, closePool } from './db/pool.js';
import * as usersDb from './db/users.js';
import { verifyToken, verifyPassword, signToken } from './auth.js';
import { OLLAMA_HOST, OLLAMA_EMBEDDING_MODEL, normalizeText, withRetry, embedTexts } from './processing.js';
import { extractQueue, ocrQueue, indexQueue, checkRedisHealth } from './queue.js';
import { logEvent } from './logger.js';
import { register, httpRequestDuration, refreshQueueMetrics } from './metrics.js';
import { loginLimiter, llmRouteLimiter, uploadLimiter, rebuildLimiter } from './rateLimit.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
if (!process.env.JWT_SECRET?.trim()) {
  console.error('JWT_SECRET is required and must not be empty');
  process.exit(1);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() || '';
const ANSWER_MODEL = 'claude-sonnet-5';
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL !== undefined ? process.env.OLLAMA_MODEL.trim() : 'llama3.1';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map((origin) => origin.trim());
const MAX_QUESTION_LENGTH = 2000;
const MAX_DOCUMENT_IDS = 100;
const MAX_EVALUATION_CASES = 20;
const MAX_LISTING_ROWS = 500;
const DEFAULT_PAGE_SIZE = 50;
const fileLimitsMb = {
  'application/pdf': 25,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 25,
  'image/png': 25,
  'image/jpeg': 25,
  'text/plain': 10,
  'text/csv': 10
};

const stopWords = new Set(['about', 'and', 'are', 'can', 'does', 'for', 'from', 'how', 'into', 'is', 'the', 'this', 'what', 'where', 'which', 'with']);

function meaningfulTerms(terms) {
  return new Set([...terms].filter((term) => term.length > 2 && !stopWords.has(term)));
}

function searchTerms(text) {
  return (normalizeText(text).toLowerCase().match(/[a-z0-9]+/g) || []).map((term) => {
    if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
    if (term.endsWith('ing') && term.length > 5) return term.slice(0, -3);
    if (term.endsWith('ed') && term.length > 4) return term.slice(0, -2);
    if (term.endsWith('s') && term.length > 4) return term.slice(0, -1);
    return term;
  });
}

function expandedSearchTerms(text) {
  const synonyms = {
    technology: ['java', 'node', 'microservice', 'rdbms', 'nosql', 'oracle', 'react', 'jdbc'],
    skill: ['expertise', 'skilled', 'developed', 'designed', 'implemented'],
    skillset: ['skill', 'expertise', 'skilled', 'developed', 'designed', 'implemented'],
    leadership: ['led', 'lead', 'managed', 'mentored', 'team', 'spearheaded', 'scrum'],
    experience: ['employment', 'career', 'worked', 'designed', 'developed', 'implemented'],
    company: ['employment', 'employer', 'organization', 'staff', 'senior', 'engineer', 'celigo', 'citrix', 'netscaler'],
    frontend: ['react', 'web', 'presentation', 'internal'],
    database: ['rdbms', 'nosql', 'oracle', 'database', 'microservice'],
    backend: ['java', 'node', 'microservice', 'rdbms', 'oracle'],
    project: ['feature', 'service', 'microservice', 'implementation']
  };
  const terms = new Set(searchTerms(text));
  for (const term of [...terms]) {
    for (const synonym of synonyms[term] || []) terms.add(synonym);
  }
  return terms;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftMagnitude += left[i] ** 2;
    rightMagnitude += right[i] ** 2;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

async function removeDocumentData(documentId) {
  const document = await documentsDb.deleteDocument(documentId);
  if (!document) return null;
  if (document.storageName) {
    await objectStore.deleteObject(document.storageName);
  }
  return document;
}

// For a small, focused set of documents (the common case: a resume, a report), include every
// indexed chunk in scope so multi-part or "list everything" questions aren't cut off by an
// arbitrary top-K. For a large corpus, fall back to a bounded top-K to control cost and latency.
async function resolveRetrievalLimit(documentIds) {
  const minLimit = 5;
  const maxLimit = 15;
  const candidates = await chunksDb.getIndexedChunks(documentIds);
  return Math.min(Math.max(candidates.length, minLimit), maxLimit);
}

async function searchChunks(query, documentIds = null, limit = 5) {
  const [queryEmbedding] = await embedTexts([query], 'search_query: ');
  const queryTerms = meaningfulTerms(expandedSearchTerms(query));
  const candidates = await chunksDb.getIndexedChunks(documentIds);
  return candidates
    .map((chunk) => {
      const chunkTerms = new Set(searchTerms(chunk.text));
      const overlap = [...queryTerms].filter((term) => chunkTerms.has(term)).length;
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        text: chunk.text,
        pageNumber: chunk.pageNumber,
        score: Number((cosineSimilarity(queryEmbedding, chunk.embedding) + (overlap / Math.max(queryTerms.size, 1)) * 0.75).toFixed(6))
      };
    })
    .sort((left, right) => right.score - left.score)
    .filter((result, index, all) => all.findIndex((other) => other.text === result.text) === index)
    .slice(0, limit);
}

function createExtractiveAnswer(query, results) {
  const queryTerms = meaningfulTerms(expandedSearchTerms(query));
  const relevantResults = results.map((result) => ({
    ...result,
    matchedTerms: searchTerms(result.text).filter((term) => queryTerms.has(term))
  })).filter((result) => result.matchedTerms.length > 0);
  const hasLexicalEvidence = relevantResults.length > 0;
  // Empirically retuned for nomic-embed-text (was 0.45, tuned against the old demo-hash
  // embedding): real embeddings sit on a much narrower, higher baseline range - unrelated
  // queries against this app's typical documents scored up to ~0.545, genuinely relevant ones
  // as low as ~0.56, on real test data. hasLexicalEvidence remains the primary safety net;
  // this threshold only matters when a query has zero literal term overlap with any chunk.
  const hasStrongSemanticEvidence = results[0]?.score >= 0.55;
  if (!results.length || (!hasLexicalEvidence && !hasStrongSemanticEvidence)) return null;
  const selectedResults = (relevantResults.length ? relevantResults : results).slice(0, 2);
  const snippets = selectedResults.map((result) => {
    const sentences = result.text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
    const focused = sentences.filter((sentence) => searchTerms(sentence).some((term) => queryTerms.has(term)));
    return (focused.length ? focused.slice(0, 2) : sentences.slice(0, 2)).join(' ').trim();
  }).filter(Boolean);
  return {
    text: snippets.join(' '),
    evidence: selectedResults.map((result) => ({
      chunkId: result.chunkId,
      documentId: result.documentId,
      pageNumber: result.pageNumber,
      excerpt: result.text,
      relevanceScore: result.score
    }))
  };
}


async function callOllama(system, user) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
  const data = await response.json();
  return (data.message?.content || '').trim();
}

async function callAnthropic(system, user) {
  const response = await anthropicClient.messages.create({
    model: ANSWER_MODEL,
    max_tokens: 400,
    temperature: 0.1,
    system,
    messages: [{ role: 'user', content: user }]
  });
  return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
}

async function generateGroundedAnswer(query, results) {
  if (!results.length) return null;
  const providers = [
    ...(OLLAMA_HOST && OLLAMA_MODEL ? [{ name: `ollama:${OLLAMA_MODEL}`, call: callOllama }] : []),
    ...(anthropicClient ? [{ name: ANSWER_MODEL, call: callAnthropic }] : [])
  ];
  if (!providers.length) throw new Error('No answer-generation providers configured');

  const { system, user } = buildGroundingPrompt(query, results);
  let lastError;
  for (const provider of providers) {
    try {
      const text = await withRetry(() => provider.call(system, user), 1);
      if (isNotFoundResponse(text)) return null;
      return {
        text,
        model: provider.name,
        evidence: results.map((result) => ({
          chunkId: result.chunkId,
          documentId: result.documentId,
          pageNumber: result.pageNumber,
          excerpt: result.text,
          relevanceScore: result.score
        }))
      };
    } catch (error) {
      lastError = error;
      logEvent('answer_generation_provider_failed', { provider: provider.name, error: error.message });
    }
  }
  throw lastError;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!fileLimitsMb[file.mimetype]) {
      callback(Object.assign(new Error(`Unsupported file type: ${file.mimetype || 'unknown'}`), { status: 400 }));
      return;
    }
    callback(null, true);
  }
});

app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const route = req.route?.path || 'unmatched';
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, durationMs / 1000);
    logEvent('http_request', { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs });
  });
  next();
});

// Express 4 (unlike 5) does not forward a rejected promise from an async route handler to the
// error-handling middleware - it becomes an unhandled rejection that crashes the whole process,
// taking down every concurrent user's request, not just the one that failed. This happened twice
// live: a Postgres encoding error and a MinIO outage each killed the server. Every async route is
// wrapped in this so a failure anywhere - now or in code added later - degrades to a clean error
// response instead of an outage.
function asyncRoute(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

// Wrap every route registration once, here, rather than each call site below - this is the
// single place that guarantees no route (including ones added later) can crash the process by
// forgetting to catch its own errors. Harmless for non-async middleware like multer's upload
// handler, which manages its own error path via next() and never returns a rejected promise.
for (const method of ['get', 'post', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(asyncRoute));
}

function requireAuth(req, res, next) {
  if (req.path === '/health' || req.path === '/auth/login') return next();
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    req.user = verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  next();
}

app.use('/api', requireAuth);

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  const user = await usersDb.getUserByUsername(username);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  res.json({ token: signToken(user), username: user.username });
});

app.get('/api/health', async (req, res) => {
  const [databaseHealthy, objectStoreHealthy, redisHealthy] = await Promise.all([
    getPool().query('SELECT 1').then(() => true).catch(() => false),
    objectStore.isHealthy(),
    checkRedisHealth()
  ]);
  const healthy = databaseHealthy && objectStoreHealthy && redisHealthy;
  res.json({
    status: healthy ? 'ok' : 'degraded',
    service: 'amplify-ai-server',
    checks: { database: databaseHealthy, objectStorage: objectStoreHealthy, redis: redisHealthy }
  });
});

app.get('/metrics', async (req, res) => {
  await refreshQueueMetrics();
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/summary', (req, res) => {
  res.json({
    project: 'Amplify AI Document Intelligence',
    milestone: 'Day 1 foundation',
    status: 'in_progress',
    features: ['document upload', 'AI chat', 'report generation']
  });
});

app.get('/api/documents', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_LISTING_ROWS);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [documents, counts] = await Promise.all([
    documentsDb.getAllDocuments(limit, offset),
    documentsDb.getDocumentCounts()
  ]);
  res.json({ documents, total: counts.total, indexedCount: counts.indexed, limit, offset });
});

app.get('/api/documents/:id', async (req, res) => {
  const document = await documentsDb.getDocumentById(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json({ document });
});

app.get('/api/documents/:id/extraction', async (req, res) => {
  const extraction = await extractionsDb.getExtractionByDocumentId(req.params.id);
  if (!extraction) {
    res.status(404).json({ error: 'Extraction not found' });
    return;
  }
  res.json({ extraction });
});

app.get('/api/documents/:id/chunks', async (req, res) => {
  const document = await documentsDb.getDocumentById(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json({ chunks: await chunksDb.getChunksByDocumentId(req.params.id) });
});

app.post('/api/search', llmRouteLimiter, async (req, res) => {
  const query = typeof req.body?.query === 'string' ? normalizeText(req.body.query) : '';
  const requestedLimit = Number(req.body?.limit) || 5;
  const limit = Math.min(Math.max(requestedLimit, 1), 20);
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!query) {
    res.status(400).json({ error: 'A non-empty query is required' });
    return;
  }
  if (query.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: `Query exceeds the ${MAX_QUESTION_LENGTH} character limit` });
    return;
  }
  if (documentIds && documentIds.length > MAX_DOCUMENT_IDS) {
    res.status(400).json({ error: `Too many document IDs (max ${MAX_DOCUMENT_IDS})` });
    return;
  }

  const results = await searchChunks(query, documentIds, limit);
  res.json({ query, results, index: OLLAMA_EMBEDDING_MODEL });
});

app.post('/api/search/evaluate', llmRouteLimiter, async (req, res) => {
  const cases = Array.isArray(req.body?.cases) ? req.body.cases : [];
  if (!cases.length) {
    res.status(400).json({ error: 'At least one evaluation case is required' });
    return;
  }
  if (cases.length > MAX_EVALUATION_CASES) {
    res.status(400).json({ error: `Too many evaluation cases (max ${MAX_EVALUATION_CASES})` });
    return;
  }
  const evaluations = await Promise.all(cases.map(async (evaluationCase) => {
    const query = typeof evaluationCase.query === 'string' ? normalizeText(evaluationCase.query) : '';
    const expectedDocumentIds = Array.isArray(evaluationCase.expectedDocumentIds) ? evaluationCase.expectedDocumentIds : [];
    const results = query ? await searchChunks(query, null, 5) : [];
    const relevantResults = results.filter((result) => expectedDocumentIds.includes(result.documentId));
    return {
      query,
      expectedDocumentIds,
      topDocumentIds: results.map((result) => result.documentId),
      hit: relevantResults.length > 0,
      reciprocalRank: relevantResults.length ? 1 / (results.findIndex((result) => expectedDocumentIds.includes(result.documentId)) + 1) : 0
    };
  }));
  const hits = evaluations.filter((evaluation) => evaluation.hit).length;
  const meanReciprocalRank = evaluations.reduce((total, evaluation) => total + evaluation.reciprocalRank, 0) / evaluations.length;
  res.json({
    totalCases: evaluations.length,
    hits,
    hitRate: Number((hits / evaluations.length).toFixed(3)),
    meanReciprocalRank: Number(meanReciprocalRank.toFixed(3)),
    evaluations
  });
});

app.post('/api/questions', llmRouteLimiter, async (req, res) => {
  const question = typeof req.body?.question === 'string' ? normalizeText(req.body.question) : '';
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!question) {
    res.status(400).json({ error: 'A non-empty question is required' });
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: `Question exceeds the ${MAX_QUESTION_LENGTH} character limit` });
    return;
  }
  if (documentIds && documentIds.length > MAX_DOCUMENT_IDS) {
    res.status(400).json({ error: `Too many document IDs (max ${MAX_DOCUMENT_IDS})` });
    return;
  }

  const query = {
    id: `query_${randomUUID()}`,
    question,
    documentIds,
    status: 'retrieving',
    answer: null,
    answerModel: null,
    evidence: [],
    citations: [],
    createdAt: new Date().toISOString()
  };
  const retrievalLimit = await resolveRetrievalLimit(documentIds);
  const results = await searchChunks(question, documentIds, retrievalLimit);
  let answer = null;
  let generationFailed = true;
  try {
    answer = await generateGroundedAnswer(question, results);
    generationFailed = false;
    if (answer) query.answerModel = answer.model;
  } catch (error) {
    logEvent('answer_generation_failed', { queryId: query.id, error: error.message });
  }
  if (generationFailed) {
    answer = createExtractiveAnswer(question, results);
    if (answer) query.answerModel = 'extractive-fallback';
  }
  if (!answer) {
    query.status = 'no_evidence';
    query.answer = 'No indexed document evidence was found for this question.';
  } else {
    query.status = 'completed';
    query.answer = answer.text;
    query.evidence = answer.evidence;
    const documentsById = new Map((await documentsDb.getAllDocuments()).map((document) => [document.id, document]));
    query.citations = answer.evidence.map((evidence) => ({
      documentId: evidence.documentId,
      documentName: documentsById.get(evidence.documentId)?.name || 'Unknown document',
      pageNumber: evidence.pageNumber,
      chunkId: evidence.chunkId,
      excerpt: evidence.excerpt,
      relevanceScore: evidence.relevanceScore
    }));
  }
  const savedQuery = await queriesDb.insertQuery(query);
  res.status(201).json(savedQuery);
});

app.get('/api/questions/:id', async (req, res) => {
  const query = await queriesDb.getQueryById(req.params.id);
  if (!query) {
    res.status(404).json({ error: 'Question not found' });
    return;
  }
  res.json(query);
});

app.post('/api/reports', async (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'Document intelligence report';
  const queryIds = Array.isArray(req.body?.queryIds) ? req.body.queryIds : [];
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];
  if (queryIds.length > MAX_DOCUMENT_IDS || documentIds.length > MAX_DOCUMENT_IDS) {
    res.status(400).json({ error: `Too many IDs (max ${MAX_DOCUMENT_IDS})` });
    return;
  }
  const queries = queryIds.length ? await queriesDb.getQueriesByIds(queryIds) : [];
  const documents = (await documentsDb.getAllDocuments()).filter((document) => documentIds.includes(document.id));
  if (!queries.length && !documents.length) {
    res.status(400).json({ error: 'At least one question or document is required' });
    return;
  }

  const reportId = `report_${randomUUID()}`;
  const lines = [`# ${title}`, '', `Generated: ${new Date().toISOString()}`, '', '## Source documents'];
  for (const document of documents) lines.push(`- ${document.name} (${document.status})`);
  lines.push('', '## Findings');
  for (const query of queries) {
    lines.push(`### ${query.question}`, '', query.answer || 'No answer available.', '');
    if (query.citations?.length) {
      lines.push('Sources:');
      for (const citation of query.citations) lines.push(`- ${citation.documentName}, page ${citation.pageNumber}: ${citation.excerpt}`);
      lines.push('');
    }
  }
  const report = {
    id: reportId,
    title,
    documentIds,
    queryIds,
    format: 'markdown',
    status: 'completed',
    content: lines.join('\n'),
    downloadUrl: `/api/reports/${reportId}/download`,
    createdAt: new Date().toISOString()
  };
  await reportsDb.insertReport(report);
  res.status(201).json({ ...report, content: undefined });
});

app.get('/api/reports', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_LISTING_ROWS);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [reports, total] = await Promise.all([
    reportsDb.getAllReports(limit, offset),
    reportsDb.countReports()
  ]);
  res.json({ reports: reports.map(({ content, ...report }) => report), total, limit, offset });
});

app.get('/api/reports/:id/download', async (req, res) => {
  const report = await reportsDb.getReportById(req.params.id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.type('text/markdown').attachment(`${report.id}.md`).send(report.content);
});

app.post('/api/index/rebuild', rebuildLimiter, async (req, res) => {
  const documents = await documentsDb.getAllDocuments();
  let enqueued = 0;
  let skipped = 0;
  for (const document of documents) {
    if (['queued', 'processing'].includes(document.embeddingStatus)) continue;
    if (enqueued >= MAX_LISTING_ROWS) { skipped += 1; continue; }
    const existingChunks = await chunksDb.getChunksByDocumentId(document.id);
    if (!existingChunks.length) continue;
    await documentsDb.updateDocument(document.id, { embeddingStatus: 'queued', updatedAt: new Date().toISOString(), error: null });
    await indexQueue.add('index', { documentId: document.id }, { jobId: document.id });
    enqueued += 1;
  }
  res.status(202).json({ enqueued, skipped, documentCount: documents.length, model: OLLAMA_EMBEDDING_MODEL });
});

app.delete('/api/documents/:id', async (req, res) => {
  const document = await removeDocumentData(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.status(204).send();
});

app.post('/api/documents/:id/index', async (req, res) => {
  const document = await documentsDb.getDocumentById(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (['queued', 'processing'].includes(document.embeddingStatus)) {
    res.status(409).json({ error: 'Document is already queued or being indexed' });
    return;
  }
  const existingChunks = await chunksDb.getChunksByDocumentId(document.id);
  if (!existingChunks.length) {
    res.status(422).json({ error: 'Extract document text before creating embeddings' });
    return;
  }
  const updated = await documentsDb.updateDocument(document.id, {
    embeddingStatus: 'queued',
    updatedAt: new Date().toISOString(),
    error: null
  });
  await indexQueue.add('index', { documentId: document.id }, { jobId: document.id });
  res.status(202).json({ document: updated });
});

const extensionByMimeType = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/plain': '.txt',
  'text/csv': '.csv'
};

app.post('/api/documents', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'A document file is required' });
    return;
  }

  const maxSizeBytes = fileLimitsMb[req.file.mimetype] * 1024 * 1024;
  if (req.file.size > maxSizeBytes) {
    res.status(413).json({ error: `File exceeds the ${fileLimitsMb[req.file.mimetype]} MB limit` });
    return;
  }

  const now = new Date().toISOString();
  const id = `doc_${randomUUID()}`;
  const storageName = `documents/${id}/original${extensionByMimeType[req.file.mimetype] || ''}`;
  await objectStore.putObject(storageName, req.file.buffer, req.file.mimetype);

  const document = await documentsDb.insertDocument({
    id,
    name: path.basename(req.file.originalname).replace(/[\r\n]/g, '').slice(0, 255),
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    status: 'uploaded',
    uploadedAt: now,
    updatedAt: now,
    pageCount: null,
    error: null,
    storageName
  });
  res.status(201).json({ document });
});

app.post('/api/documents/:id/extract', async (req, res) => {
  const existing = await documentsDb.getDocumentById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (['queued', 'extracting'].includes(existing.status)) {
    res.status(409).json({ error: 'Document is already queued or extracting' });
    return;
  }
  const document = await documentsDb.updateDocument(existing.id, {
    status: 'queued',
    updatedAt: new Date().toISOString(),
    error: null
  });
  await extractQueue.add('extract', { documentId: document.id }, { jobId: document.id });
  res.status(202).json({ document });
});

app.post('/api/documents/:id/ocr', async (req, res) => {
  const existing = await documentsDb.getDocumentById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!['image/png', 'image/jpeg'].includes(existing.mimeType)) {
    res.status(422).json({ error: 'OCR currently supports PNG and JPEG scans' });
    return;
  }
  if (['queued', 'extracting'].includes(existing.status)) {
    res.status(409).json({ error: 'Document is already queued or extracting' });
    return;
  }
  const document = await documentsDb.updateDocument(existing.id, {
    status: 'queued',
    updatedAt: new Date().toISOString(),
    error: null
  });
  await ocrQueue.add('ocr', { documentId: document.id }, { jobId: document.id });
  res.status(202).json({ document });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File exceeds the 25 MB upload limit' });
    return;
  }
  if (error) {
    logEvent('request_error', { requestId: res.getHeader('x-request-id'), message: error.message, type: error.type });
    if (error.type === 'entity.too.large' || error.status === 413) {
      res.status(413).json({ error: 'Request payload is too large' });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The request body could not be parsed' });
      return;
    }
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      // An explicitly marked client error (e.g. multer's fileFilter rejecting an unsupported
      // type) - its message is intended to be shown, unlike an unexpected server failure.
      res.status(error.status).json({ error: error.message });
      return;
    }
    // Anything else - a Postgres or MinIO failure forwarded by asyncRoute, most likely - is an
    // infrastructure problem, not something wrong with the request. Don't call it a parsing issue.
    // Log the stack trace here specifically - this is the one branch where root-causing a failure
    // otherwise requires reproducing it locally, since the response itself deliberately never
    // exposes internals to the client.
    logEvent('unhandled_error', { requestId: res.getHeader('x-request-id'), message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  next();
});

try {
  await objectStore.ensureBucket();
} catch (error) {
  // Don't let a transient object-storage outage prevent the process from starting at all -
  // /api/health will correctly report it as unhealthy once the server is up.
  logEvent('object_store_startup_check_failed', { error: error.message });
}

const server = app.listen(PORT, () => {
  logEvent('server_started', { port: PORT });
});

function shutdown(signal) {
  logEvent('server_shutdown_started', { signal });
  server.close(async () => {
    await closePool();
    logEvent('server_shutdown_completed');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
