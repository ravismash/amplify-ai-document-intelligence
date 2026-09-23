import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createWorker } from 'tesseract.js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildGroundingPrompt, isNotFoundResponse } from './prompt.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const API_KEY = process.env.API_KEY?.trim() || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() || '';
const ANSWER_MODEL = 'claude-sonnet-5';
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const OLLAMA_HOST = process.env.OLLAMA_HOST !== undefined ? process.env.OLLAMA_HOST.trim() : 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || 'llama3.1';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map((origin) => origin.trim());
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const storageDirectory = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(currentDirectory, 'storage');
const uploadsDirectory = path.join(storageDirectory, 'uploads');
const metadataPath = path.join(storageDirectory, 'documents.json');
const extractionsPath = path.join(storageDirectory, 'extractions.json');
const chunksPath = path.join(storageDirectory, 'chunks.json');
const queriesPath = path.join(storageDirectory, 'queries.json');
const reportsPath = path.join(storageDirectory, 'reports.json');
const fileLimitsMb = {
  'application/pdf': 25,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 25,
  'image/png': 25,
  'image/jpeg': 25,
  'text/plain': 10,
  'text/csv': 10
};

fs.mkdirSync(uploadsDirectory, { recursive: true });
if (!fs.existsSync(metadataPath)) fs.writeFileSync(metadataPath, '[]');
if (!fs.existsSync(extractionsPath)) fs.writeFileSync(extractionsPath, '[]');
if (!fs.existsSync(chunksPath)) fs.writeFileSync(chunksPath, '[]');
if (!fs.existsSync(queriesPath)) fs.writeFileSync(queriesPath, '[]');
if (!fs.existsSync(reportsPath)) fs.writeFileSync(reportsPath, '[]');

function readDocuments() {
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
}

function writeDocuments(documents) {
  fs.writeFileSync(metadataPath, JSON.stringify(documents, null, 2));
}

// Re-reads the documents file and applies `mutate` synchronously (no `await` in between),
// so a write made by a concurrent request in between cannot be clobbered by a stale in-memory copy.
function updateDocument(id, mutate) {
  const documents = readDocuments();
  const document = documents.find((item) => item.id === id);
  if (!document) return null;
  mutate(document);
  writeDocuments(documents);
  return document;
}

function readExtractions() {
  return JSON.parse(fs.readFileSync(extractionsPath, 'utf8'));
}

function writeExtractions(extractions) {
  fs.writeFileSync(extractionsPath, JSON.stringify(extractions, null, 2));
}

function readChunks() {
  return JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
}

function writeChunks(chunks) {
  fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));
}

function readQueries() {
  return JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
}

function writeQueries(queries) {
  fs.writeFileSync(queriesPath, JSON.stringify(queries, null, 2));
}

function readReports() {
  return JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
}

function writeReports(reports) {
  fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));
}

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

async function withRetry(operation, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  throw lastError;
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

function createChunks(documentId, pages) {
  const chunkSize = 900;
  const overlap = 120;
  const chunks = [];

  for (const page of pages) {
    const text = normalizeText(page.text);
    if (!text) continue;
    let start = 0;
    let chunkIndex = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunkText = text.slice(start, end).trim();
      chunks.push({
        id: `chunk_${randomUUID()}`,
        documentId,
        text: chunkText,
        pageNumber: page.pageNumber,
        section: null,
        chunkIndex,
        characterStart: start,
        characterEnd: end,
        embeddingStatus: 'pending'
      });
      if (end === text.length) break;
      start = Math.max(end - overlap, start + 1);
      chunkIndex += 1;
    }
  }
  return chunks;
}

function persistChunks(documentId, pages) {
  const chunks = readChunks().filter((chunk) => chunk.documentId !== documentId);
  const documentChunks = createChunks(documentId, pages);
  writeChunks([...documentChunks, ...chunks]);
  return documentChunks;
}

function createDemoEmbedding(text) {
  const dimensions = 64;
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = normalizeText(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest[0] % dimensions;
    const sign = digest[1] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + (digest[2] / 255));
  }
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value ** 2, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(left, right) {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function indexDocumentChunks(documentId) {
  const chunks = readChunks();
  const documentChunks = chunks.filter((chunk) => chunk.documentId === documentId);
  if (!documentChunks.length) return [];
  const indexedChunks = documentChunks.map((chunk) => ({
    ...chunk,
    embedding: createDemoEmbedding(chunk.text),
    embeddingModel: 'local-demo-hash-v1',
    embeddingDimensions: 64,
    embeddingStatus: 'indexed',
    indexedAt: new Date().toISOString()
  }));
  const indexedIds = new Map(indexedChunks.map((chunk) => [chunk.id, chunk]));
  writeChunks(chunks.map((chunk) => indexedIds.get(chunk.id) || chunk));
  return indexedChunks;
}

function removeDocumentData(documentId) {
  const documents = readDocuments();
  const document = documents.find((item) => item.id === documentId);
  if (!document) return null;
  const remainingDocuments = documents.filter((item) => item.id !== documentId);
  writeDocuments(remainingDocuments);
  writeExtractions(readExtractions().filter((item) => item.documentId !== documentId));
  writeChunks(readChunks().filter((item) => item.documentId !== documentId));
  if (document.storageName) {
    const filePath = path.join(uploadsDirectory, document.storageName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  return document;
}

// For a small, focused set of documents (the common case: a resume, a report), include every
// indexed chunk in scope so multi-part or "list everything" questions aren't cut off by an
// arbitrary top-K. For a large corpus, fall back to a bounded top-K to control cost and latency.
function resolveRetrievalLimit(documentIds) {
  const minLimit = 5;
  const maxLimit = 15;
  const candidateCount = readChunks()
    .filter((chunk) => chunk.embeddingStatus === 'indexed' && (!documentIds || documentIds.includes(chunk.documentId)))
    .length;
  return Math.min(Math.max(candidateCount, minLimit), maxLimit);
}

function searchChunks(query, documentIds = null, limit = 5) {
  const queryEmbedding = createDemoEmbedding(query);
  const queryTerms = meaningfulTerms(expandedSearchTerms(query));
  return readChunks()
    .filter((chunk) => chunk.embeddingStatus === 'indexed' && Array.isArray(chunk.embedding))
    .filter((chunk) => !documentIds || documentIds.includes(chunk.documentId))
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
  const hasStrongSemanticEvidence = results[0]?.score >= 0.45;
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
    ...(OLLAMA_HOST ? [{ name: `ollama:${OLLAMA_MODEL}`, call: callOllama }] : []),
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

async function extractDocument(filePath, mimeType) {
  const buffer = await fs.promises.readFile(filePath);
  if (mimeType === 'application/pdf') {
    const parsedPdf = await pdfParse(buffer, {
      pagerender: async (pageData) => {
        const textContent = await pageData.getTextContent();
        return textContent.items.map((item) => item.str).join(' ');
      }
    });
    const pages = parsedPdf.text.split('\f').map((text, index) => ({
      pageNumber: index + 1,
      text: text.trim(),
      confidence: null
    })).filter((page) => page.text);
    return { text: parsedPdf.text.trim(), pages: pages.length ? pages : [{ pageNumber: 1, text: parsedPdf.text.trim(), confidence: null }] };
  }

  const text = buffer.toString('utf8').trim();
  return { text, pages: [{ pageNumber: 1, text, confidence: null }] };
}

async function ocrDocument(filePath) {
  const worker = await createWorker('eng');
  try {
    const result = await worker.recognize(filePath);
    const text = result.data.text.trim();
    return {
      text,
      pages: [{
        pageNumber: 1,
        text,
        confidence: Math.round(result.data.confidence)
      }]
    };
  } finally {
    await worker.terminate();
  }
}

const upload = multer({
  dest: uploadsDirectory,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!fileLimitsMb[file.mimetype]) {
      callback(new Error(`Unsupported file type: ${file.mimetype || 'unknown'}`));
      return;
    }
    callback(null, true);
  }
});

app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.on('finish', () => logEvent('http_request', {
    requestId,
    method: req.method,
    path: req.path,
    status: res.statusCode,
    durationMs: Date.now() - startedAt
  }));
  next();
});

function requireApiKey(req, res, next) {
  if (req.path === '/health' || !API_KEY) return next();
  if (req.get('x-api-key') !== API_KEY) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

app.use('/api', requireApiKey);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'amplify-ai-server', checks: { metadataStorage: fs.existsSync(metadataPath), uploadStorage: fs.existsSync(uploadsDirectory) } });
});

app.get('/api/summary', (req, res) => {
  res.json({
    project: 'Amplify AI Document Intelligence',
    milestone: 'Day 1 foundation',
    status: 'in_progress',
    features: ['document upload', 'AI chat', 'report generation']
  });
});

app.get('/api/documents', (req, res) => {
  res.json({ documents: readDocuments() });
});

app.get('/api/documents/:id', (req, res) => {
  const document = readDocuments().find((item) => item.id === req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json({ document });
});

app.get('/api/documents/:id/extraction', (req, res) => {
  const extraction = readExtractions().find((item) => item.documentId === req.params.id);
  if (!extraction) {
    res.status(404).json({ error: 'Extraction not found' });
    return;
  }
  res.json({ extraction });
});

app.get('/api/documents/:id/chunks', (req, res) => {
  const document = readDocuments().find((item) => item.id === req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json({ chunks: readChunks().filter((chunk) => chunk.documentId === req.params.id) });
});

app.post('/api/search', (req, res) => {
  const query = typeof req.body?.query === 'string' ? normalizeText(req.body.query) : '';
  const requestedLimit = Number(req.body?.limit) || 5;
  const limit = Math.min(Math.max(requestedLimit, 1), 20);
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!query) {
    res.status(400).json({ error: 'A non-empty query is required' });
    return;
  }

  const results = searchChunks(query, documentIds, limit);
  res.json({ query, results, index: 'local-demo-hash-v1' });
});

app.post('/api/search/evaluate', (req, res) => {
  const cases = Array.isArray(req.body?.cases) ? req.body.cases : [];
  if (!cases.length) {
    res.status(400).json({ error: 'At least one evaluation case is required' });
    return;
  }
  const evaluations = cases.map((evaluationCase) => {
    const query = typeof evaluationCase.query === 'string' ? normalizeText(evaluationCase.query) : '';
    const expectedDocumentIds = Array.isArray(evaluationCase.expectedDocumentIds) ? evaluationCase.expectedDocumentIds : [];
    const results = query ? searchChunks(query, null, 5) : [];
    const relevantResults = results.filter((result) => expectedDocumentIds.includes(result.documentId));
    return {
      query,
      expectedDocumentIds,
      topDocumentIds: results.map((result) => result.documentId),
      hit: relevantResults.length > 0,
      reciprocalRank: relevantResults.length ? 1 / (results.findIndex((result) => expectedDocumentIds.includes(result.documentId)) + 1) : 0
    };
  });
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

app.post('/api/questions', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? normalizeText(req.body.question) : '';
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!question) {
    res.status(400).json({ error: 'A non-empty question is required' });
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
  const results = searchChunks(question, documentIds, resolveRetrievalLimit(documentIds));
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
    const documentsById = new Map(readDocuments().map((document) => [document.id, document]));
    query.citations = answer.evidence.map((evidence) => ({
      documentId: evidence.documentId,
      documentName: documentsById.get(evidence.documentId)?.name || 'Unknown document',
      pageNumber: evidence.pageNumber,
      chunkId: evidence.chunkId,
      excerpt: evidence.excerpt,
      relevanceScore: evidence.relevanceScore
    }));
  }
  const queries = readQueries();
  queries.unshift(query);
  writeQueries(queries);
  res.status(201).json(query);
});

app.get('/api/questions/:id', (req, res) => {
  const query = readQueries().find((item) => item.id === req.params.id);
  if (!query) {
    res.status(404).json({ error: 'Question not found' });
    return;
  }
  res.json(query);
});

app.post('/api/reports', (req, res) => {
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'Document intelligence report';
  const queryIds = Array.isArray(req.body?.queryIds) ? req.body.queryIds : [];
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];
  const queries = readQueries().filter((query) => queryIds.includes(query.id));
  const documents = readDocuments().filter((document) => documentIds.includes(document.id));
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
  const reports = readReports();
  reports.unshift(report);
  writeReports(reports);
  res.status(201).json({ ...report, content: undefined });
});

app.get('/api/reports', (req, res) => {
  res.json({ reports: readReports().map(({ content, ...report }) => report) });
});

app.get('/api/reports/:id/download', (req, res) => {
  const report = readReports().find((item) => item.id === req.params.id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.type('text/markdown').attachment(`${report.id}.md`).send(report.content);
});

app.post('/api/index/rebuild', (req, res) => {
  const documents = readDocuments();
  const indexed = [];
  for (const document of documents) {
    if (readChunks().some((chunk) => chunk.documentId === document.id)) {
      indexed.push(...indexDocumentChunks(document.id));
      document.status = 'ready';
      document.embeddingStatus = 'indexed';
      document.updatedAt = new Date().toISOString();
    }
  }
  writeDocuments(documents);
  res.json({ indexedChunks: indexed.length, documentCount: documents.length, model: 'local-demo-hash-v1' });
});

app.delete('/api/documents/:id', (req, res) => {
  const document = removeDocumentData(req.params.id);
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.status(204).send();
});

app.post('/api/documents/:id/index', (req, res) => {
  const documents = readDocuments();
  const documentIndex = documents.findIndex((item) => item.id === req.params.id);
  if (documentIndex === -1) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  const document = documents[documentIndex];
  try {
    const chunks = indexDocumentChunks(document.id);
    if (!chunks.length) {
      res.status(422).json({ error: 'Extract document text before creating embeddings' });
      return;
    }
    document.status = 'ready';
    document.embeddingStatus = 'indexed';
    document.chunkCount = chunks.length;
    document.updatedAt = new Date().toISOString();
    document.error = null;
    writeDocuments(documents);
    res.json({ document, chunks, model: 'local-demo-hash-v1' });
  } catch (error) {
    document.embeddingStatus = 'failed';
    document.error = error.message;
    document.updatedAt = new Date().toISOString();
    writeDocuments(documents);
    res.status(422).json({ error: `Embedding generation failed: ${error.message}`, document });
  }
});

app.post('/api/documents', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'A document file is required' });
    return;
  }

  const maxSizeBytes = fileLimitsMb[req.file.mimetype] * 1024 * 1024;
  if (req.file.size > maxSizeBytes) {
    fs.unlinkSync(req.file.path);
    res.status(413).json({ error: `File exceeds the ${fileLimitsMb[req.file.mimetype]} MB limit` });
    return;
  }

  const now = new Date().toISOString();
  const document = {
    id: `doc_${randomUUID()}`,
    name: path.basename(req.file.originalname).replace(/[\r\n]/g, '').slice(0, 255),
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    status: 'uploaded',
    uploadedAt: now,
    updatedAt: now,
    pageCount: null,
    error: null,
    storageName: req.file.filename
  };

  const documents = readDocuments();
  documents.unshift(document);
  writeDocuments(documents);
  res.status(201).json({ document });
});

app.post('/api/documents/:id/extract', async (req, res) => {
  let document = updateDocument(req.params.id, (doc) => {
    doc.status = 'extracting';
    doc.updatedAt = new Date().toISOString();
    doc.error = null;
  });
  if (!document) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  try {
    const result = await withRetry(() => extractDocument(path.join(uploadsDirectory, document.storageName), document.mimeType));
    const extraction = {
      documentId: document.id,
      status: 'completed',
      text: result.text,
      pages: result.pages,
      error: null,
      extractedAt: new Date().toISOString()
    };
    const extractions = readExtractions().filter((item) => item.documentId !== document.id);
    extractions.unshift(extraction);
    writeExtractions(extractions);
    const chunks = persistChunks(document.id, result.pages);

    document = updateDocument(document.id, (doc) => {
      doc.status = 'extracted';
      doc.pageCount = result.pages.length;
      doc.chunkCount = chunks.length;
      doc.updatedAt = new Date().toISOString();
    });
    res.json({ document, extraction, chunks });
  } catch (error) {
    document = updateDocument(document.id, (doc) => {
      doc.status = 'failed';
      doc.error = error.message;
      doc.updatedAt = new Date().toISOString();
    });
    res.status(422).json({ error: `Text extraction failed: ${error.message}`, document });
  }
});

app.post('/api/documents/:id/ocr', async (req, res) => {
  const existing = readDocuments().find((item) => item.id === req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!['image/png', 'image/jpeg'].includes(existing.mimeType)) {
    res.status(422).json({ error: 'OCR currently supports PNG and JPEG scans' });
    return;
  }

  let document = updateDocument(req.params.id, (doc) => {
    doc.status = 'extracting';
    doc.updatedAt = new Date().toISOString();
    doc.error = null;
  });

  try {
    const result = await withRetry(() => ocrDocument(path.join(uploadsDirectory, document.storageName)));
    const extraction = {
      documentId: document.id,
      status: 'completed',
      method: 'ocr',
      text: result.text,
      pages: result.pages,
      error: null,
      extractedAt: new Date().toISOString()
    };
    const extractions = readExtractions().filter((item) => item.documentId !== document.id);
    extractions.unshift(extraction);
    writeExtractions(extractions);
    const chunks = persistChunks(document.id, result.pages);

    document = updateDocument(document.id, (doc) => {
      doc.status = 'extracted';
      doc.pageCount = 1;
      doc.chunkCount = chunks.length;
      doc.updatedAt = new Date().toISOString();
    });
    res.json({ document, extraction, chunks });
  } catch (error) {
    document = updateDocument(document.id, (doc) => {
      doc.status = 'failed';
      doc.error = error.message;
      doc.updatedAt = new Date().toISOString();
    });
    res.status(422).json({ error: `OCR failed: ${error.message}`, document });
  }
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
    res.status(400).json({ error: 'The request body could not be parsed' });
    return;
  }
  next();
});

const server = app.listen(PORT, () => {
  logEvent('server_started', { port: PORT });
});

function shutdown(signal) {
  logEvent('server_shutdown_started', { signal });
  server.close(() => {
    logEvent('server_shutdown_completed');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
