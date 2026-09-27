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
import { OLLAMA_HOST, OLLAMA_EMBEDDING_MODEL, normalizeText, withRetry, embedTexts, detectSectionMarkers, concatenatePages } from './processing.js';
import { extractQueue, ocrQueue, indexQueue, checkRedisHealth, enqueueUnique } from './queue.js';
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
const OLLAMA_MODEL = process.env.OLLAMA_MODEL !== undefined ? process.env.OLLAMA_MODEL.trim() : 'qwen2.5:14b';
// Optional third-party or self-hosted provider for A/B-testing answer quality (e.g. a RunPod vLLM
// endpoint, Groq, OpenRouter, Together, DeepInfra, Fireworks) - any of them speak the same
// OpenAI-compatible /chat/completions shape. Unset by default; only active when a base URL is
// configured, so it never changes behavior for a purely local deployment.
const CUSTOM_LLM_BASE_URL = process.env.CUSTOM_LLM_BASE_URL?.trim() || '';
const CUSTOM_LLM_API_KEY = process.env.CUSTOM_LLM_API_KEY?.trim() || '';
const CUSTOM_LLM_MODEL = process.env.CUSTOM_LLM_MODEL?.trim() || '';
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
  return new Set(searchTerms(text));
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

// How many top-ranked excerpts the answer model reads. Measured on eval/questions.json with
// qwen2.5:14b: 6 scored 15/18 because the correct clause sometimes ranked just outside the
// window (this demo corpus has only ~11 chunks total, so a handful of lexically-similar but
// wrong chunks is enough to push it out) - the model then answered from a related but incorrect
// clause instead of refusing. 11 (near-total recall for this corpus) scored 17/18 at a real but
// acceptable latency cost. Re-run `node scripts/eval-answers.js` before changing this.
const ANSWER_CONTEXT_CHUNKS = Number(process.env.ANSWER_CONTEXT_CHUNKS) || 11;

// When the candidate pool (the whole corpus, or a documentIds-scoped subset) is small enough to
// read in full, skip similarity ranking entirely and send every chunk, in original document
// order. Similarity search is a lossy approximation for when a document doesn't fit in context -
// it's also fundamentally bad at structural/positional questions ("how many chapters", "what does
// chapter 1 say") that don't have a single topically-matching chunk to rank highly. ~20,000 chars
// (~5,000 tokens) leaves headroom under the local model's 8192-token context (system prompt +
// question + generation budget) while comfortably covering a handful of typical business
// documents (a contract, an invoice, a policy - each usually a few thousand characters).
const FULL_CONTEXT_MAX_CHARS = Number(process.env.FULL_CONTEXT_MAX_CHARS) || 20000;

async function resolveContextChunks(query, documentIds) {
  const candidates = await chunksDb.getIndexedChunks(documentIds);
  const totalChars = candidates.reduce((sum, chunk) => sum + chunk.text.length, 0);
  if (candidates.length && totalChars <= FULL_CONTEXT_MAX_CHARS) {
    return [...candidates]
      // chunk_index resets to 0 per page/sheet (not a global counter), so page number must sort
      // first to reconstruct true reading order across a multi-page/multi-sheet document.
      .sort((left, right) => left.documentId.localeCompare(right.documentId)
        || (left.pageNumber || 0) - (right.pageNumber || 0)
        || left.chunkIndex - right.chunkIndex)
      .filter((chunk, index, all) => all.findIndex((other) => other.text === chunk.text) === index)
      .map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        text: chunk.text,
        pageNumber: chunk.pageNumber,
        score: 1
      }));
  }
  return searchChunks(query, documentIds, ANSWER_CONTEXT_CHUNKS);
}

const AUTO_SCOPE_SAMPLE_SIZE = 15;
// How much a document's single best-matching chunk must lead the runner-up's best chunk by, on
// this app's combined cosine + lexical-overlap score, to count as a clear winner rather than an
// ambiguous tie. Deliberately conservative (found by testing, not guessed): a 0.2 lead let a
// status report confidently out-narrow the actual policy document for "who approves the $1.2M
// budget" - the report discusses the same budget in passing, which is close enough in content
// similarity to win, but doesn't have the approval rule itself. Unlike the filename check above,
// content similarity has no way to know it picked a document that merely *mentions* the topic
// instead of the one that *answers* the question, so this only fires on a much clearer margin;
// anything narrower stays unscoped, which is safer than a confident wrong guess.
const AUTO_SCOPE_MIN_LEAD = 0.4;

// An unscoped question against a mixed corpus is the single biggest accuracy risk found in this
// app's own eval history (72% unscoped vs. 94% scoped, identical questions) - irrelevant chunks
// from unrelated documents dilute or outright crowd out the right one in the final prompt.
// Manually scoping fixes that; this reproduces the same effect automatically for the common case
// where a question is clearly "about" one document, without requiring the user to click anything.
async function resolveAutoScope(question, documentIds) {
  if (documentIds) return documentIds; // user already scoped explicitly - never override that

  // A distinctive word from the question appearing in a document's own name ("Northwind" in the
  // question, "Northwind Master Supply Agreement.pdf" as a document) is checked first - it's a
  // far more reliable signal than content similarity when the corpus is lopsided, per the failure
  // described above, where content-based scoring alone picked the wrong document.
  const questionTerms = [...meaningfulTerms(expandedSearchTerms(question))].filter((term) => term.length > 3);
  const documents = await documentsDb.getAllDocuments();
  const nameMatches = documents.filter((document) => {
    const nameTerms = new Set(searchTerms(document.name));
    return questionTerms.some((term) => nameTerms.has(term));
  });
  if (nameMatches.length && nameMatches.length <= 3) return nameMatches.map((document) => document.id);

  // Otherwise fall back to content-based dominance, using each document's single best-matching
  // chunk rather than the sum across however many of its chunks land in the sample - so a large
  // document doesn't win purely by having more chances to score reasonably on generic terms.
  const sample = await searchChunks(question, null, AUTO_SCOPE_SAMPLE_SIZE);
  const maxByDocument = new Map();
  for (const result of sample) {
    maxByDocument.set(result.documentId, Math.max(maxByDocument.get(result.documentId) || 0, result.score));
  }
  const ranked = [...maxByDocument.entries()].sort((left, right) => right[1] - left[1]);
  if (!ranked.length) return null;
  const [, topScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  if (topScore - runnerUpScore < AUTO_SCOPE_MIN_LEAD) return null;
  // Include any other document within the same close margin of the top one, so a question
  // spanning two closely related documents (e.g. a contract and its matching invoice) isn't cut
  // down to just one.
  return ranked.filter(([, score]) => topScore - score < AUTO_SCOPE_MIN_LEAD).map(([documentId]) => documentId);
}

// Extracts a leading chapter/section number from a detected section title ("Chapter 3" -> 3,
// "3. Competitive quotes" -> 3) so a question naming a number can be matched to the right section.
function sectionNumber(title) {
  const match = title.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

// A question can name a chapter either way ("chapter 1" or "chapter one") - this app's own eval
// history shows both phrasings in real use, so both need to resolve to the same section.
function extractNamedNumber(question) {
  const digitMatch = question.match(/\b(?:chapter|section)\s+(\d+)\b/i);
  if (digitMatch) return Number(digitMatch[1]);
  const wordMatch = question.match(/\b(?:chapter|section)\s+([a-z]+)\b/i);
  if (wordMatch) {
    const index = NUMBER_WORDS.indexOf(wordMatch[1].toLowerCase());
    if (index >= 0) return index;
  }
  return null;
}

// Structural questions ("how many chapters", "what does chapter 3 say") ask about a document's
// own organization, not a fact any single chunk contains - similarity search can't answer them
// (see FULL_CONTEXT_MAX_CHARS comment above). Sections are computed fresh from the stored
// extraction on every call, not from chunks.section: a chunk can span multiple detected sections
// (a short document's whole text can be one or two chunks), so per-chunk section labels are
// reliable for large documents only by coincidence, never guaranteed for small ones. Only handled
// when scoped to exactly one document, where "the document's sections" is unambiguous; returns
// null (falls through to the normal retrieval flow) for anything else, including a document with
// no detected structure at all.
async function resolveStructuralAnswer(question, documentIds) {
  if (!documentIds || documentIds.length !== 1) return null;
  const [documentId] = documentIds;
  const extraction = await extractionsDb.getExtractionByDocumentId(documentId);
  if (!extraction?.pages?.length) return null;
  const markers = detectSectionMarkers(extraction.pages);
  if (!markers.length) return null;

  if (/\bhow many\b.*\b(chapters?|sections?)\b/i.test(question) || /\b(list|what are)\b.*\b(chapters?|sections?)\b/i.test(question)) {
    return {
      text: `This document has ${markers.length} detected section${markers.length === 1 ? '' : 's'}: ${markers.map((marker) => marker.title).join(', ')}.`,
      model: 'structural-lookup',
      evidence: []
    };
  }

  const targetNumber = extractNamedNumber(question);
  if (targetNumber !== null) {
    const markerIndex = markers.findIndex((marker) => sectionNumber(marker.title) === targetNumber);
    if (markerIndex < 0) return null;
    const fullText = concatenatePages(extraction.pages);
    const sectionText = fullText.slice(markers[markerIndex].globalOffset, markers[markerIndex + 1]?.globalOffset ?? fullText.length).trim();
    if (!sectionText) return null;
    const syntheticResult = { chunkId: `section_${documentId}_${targetNumber}`, documentId, text: sectionText, pageNumber: markers[markerIndex].pageNumber, score: 1 };
    return generateGroundedAnswer(question, [syntheticResult]);
  }

  return null;
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
  })).filter((result) => result.matchedTerms.length > 0)
    // Rank by lexical match strength rather than trusting input order - `results` is relevance-
    // sorted when it comes from searchChunks, but document-ordered when it comes from
    // resolveContextChunks' full-context path, so this function must not assume index 0 is best.
    .sort((left, right) => right.matchedTerms.length - left.matchedTerms.length);
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
      // num_ctx: the prompt (system + up to ANSWER_CONTEXT_CHUNKS excerpts) can run to ~3k
      // tokens, and Ollama's default 4096 context leaves too little room for the reply. With
      // context-shift enabled, overflow truncates from the *front* rather than erroring - which
      // can silently drop the system prompt (including the prompt-injection defenses). 8192
      // gives real headroom without exceeding this model's trained context length.
      options: { temperature: 0.1, num_ctx: 8192 },
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

async function callCustomProvider(system, user) {
  const response = await fetch(`${CUSTOM_LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(CUSTOM_LLM_API_KEY ? { authorization: `Bearer ${CUSTOM_LLM_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model: CUSTOM_LLM_MODEL,
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!response.ok) throw new Error(`Custom LLM provider request failed: ${response.status}`);
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
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
    // Listed first when configured, so an eval run picks it up as the primary answer source
    // (answerModel in the response/eval output shows which provider actually answered each
    // question, giving a clean side-by-side against the ollama:/claude- baselines already measured).
    ...(CUSTOM_LLM_BASE_URL && CUSTOM_LLM_MODEL ? [{ name: `custom:${CUSTOM_LLM_MODEL}`, call: callCustomProvider }] : []),
    ...(OLLAMA_HOST && OLLAMA_MODEL ? [{ name: `ollama:${OLLAMA_MODEL}`, call: callOllama }] : []),
    ...(anthropicClient ? [{ name: ANSWER_MODEL, call: callAnthropic }] : [])
  ];
  if (!providers.length) throw new Error('No answer-generation providers configured');

  const { system, user } = buildGroundingPrompt(query, results);
  let lastError;
  for (const provider of providers) {
    try {
      // attempts=2: with only the local Ollama provider configured, a transient failure (dropped
      // connection, a request queued behind another and briefly timing out) would otherwise fail
      // the whole answer with nothing to fall back to.
      const text = await withRetry(() => provider.call(system, user), 2);
      if (isNotFoundResponse(text)) return null;
      // The prompt asks for [n] markers; only those excerpts become citations. If the model gave
      // none, fall back to the top-ranked excerpt rather than citing everything it was shown.
      const citedIndexes = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]) - 1))]
        .filter((index) => index >= 0 && index < results.length);
      const citedResults = citedIndexes.length ? citedIndexes.map((index) => results[index]) : results.slice(0, 1);
      return {
        text,
        model: provider.name,
        evidence: citedResults.map((result) => ({
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

// Runs the structural -> full-context/retrieval -> extractive-fallback pipeline for one document
// scope. Factored out so /api/questions can retry it with a different scope (see the auto-scope
// fallback below) without duplicating the whole resolution flow.
async function resolveAnswerForScope(question, scopedDocumentIds, queryId) {
  let structuralAnswer = null;
  try {
    structuralAnswer = await resolveStructuralAnswer(question, scopedDocumentIds);
  } catch (error) {
    logEvent('structural_answer_failed', { queryId, error: error.message });
  }

  const results = structuralAnswer ? [] : await resolveContextChunks(question, scopedDocumentIds);
  let answer = structuralAnswer;
  let generationFailed = !structuralAnswer;
  let answerModel = structuralAnswer?.model;
  if (!structuralAnswer) {
    try {
      answer = await generateGroundedAnswer(question, results);
      generationFailed = false;
      if (answer) answerModel = answer.model;
    } catch (error) {
      logEvent('answer_generation_failed', { queryId, error: error.message });
    }
  }
  if (generationFailed) {
    answer = createExtractiveAnswer(question, results);
    if (answer) answerModel = 'extractive-fallback';
  }
  return { answer, answerModel };
}

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
    autoScopedDocumentIds: null,
    evidence: [],
    citations: [],
    createdAt: new Date().toISOString()
  };
  let effectiveDocumentIds = documentIds;
  try {
    effectiveDocumentIds = await resolveAutoScope(question, documentIds);
    if (effectiveDocumentIds && !documentIds) query.autoScopedDocumentIds = effectiveDocumentIds;
  } catch (error) {
    logEvent('auto_scope_failed', { queryId: query.id, error: error.message });
  }

  let { answer, answerModel } = await resolveAnswerForScope(question, effectiveDocumentIds, query.id);
  // Auto-scoping can guess the wrong single document when two documents plausibly relate to the
  // same question but only one actually has the answer (found in testing: a question about a
  // budget approval rule auto-scoped to a status report that mentions the same budget, instead of
  // the policy document with the actual approval table) - narrowing to the wrong document
  // guarantees a miss, worse than the original unscoped search, which at least kept the right
  // document in the candidate pool. Retrying unscoped costs nothing on the common (correct-guess)
  // path and recovers this specific failure mode on the rare wrong-guess one.
  if (!answer && query.autoScopedDocumentIds) {
    ({ answer, answerModel } = await resolveAnswerForScope(question, documentIds, query.id));
    if (answer) query.autoScopedDocumentIds = null;
  }
  if (answer) query.answerModel = answerModel;
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
    await enqueueUnique(indexQueue, 'index', document.id);
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
  await enqueueUnique(indexQueue, 'index', document.id);
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
  await enqueueUnique(extractQueue, 'extract', document.id);
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
  await enqueueUnique(ocrQueue, 'ocr', document.id);
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
