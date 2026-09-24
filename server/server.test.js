import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';

const port = 4100;
const baseUrl = `http://localhost:${port}`;

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgresql://amplify:amplify@localhost:5432/postgres';
const testDbName = `amplify_ai_test_${randomUUID().replace(/-/g, '_')}`;
const testDatabaseUrl = adminUrl.replace(/\/[^/]*$/, `/${testDbName}`);
const testBucket = `documents-test-${randomUUID()}`;
const testJwtSecret = process.env.JWT_SECRET || 'test-jwt-secret-for-local-development-only';
const testUsername = 'test-user';
const testPassword = 'Test-Password-123!';
const testQueuePrefix = `amplify_test_${randomUUID().replace(/-/g, '_')}`;
const testRateLimitPrefix = `rl_test_${randomUUID().replace(/-/g, '_')}`;

let serverProcess;
let workerProcess;
let authToken;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  process.env.DATABASE_URL = testDatabaseUrl;
  await runMigrations(testDatabaseUrl);

  const { insertUser } = await import('./db/users.js');
  const { hashPassword } = await import('./auth.js');
  await insertUser({
    id: `user_${randomUUID()}`,
    username: testUsername,
    passwordHash: await hashPassword(testPassword),
    createdAt: new Date().toISOString()
  });

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'amplify', secretAccessKey: 'amplify123' }
  });
  await s3.send(new CreateBucketCommand({ Bucket: testBucket }));

  const sharedProcessEnv = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    OBJECT_STORE_BUCKET: testBucket,
    JWT_SECRET: testJwtSecret,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    QUEUE_PREFIX: testQueuePrefix,
    RATE_LIMIT_KEY_PREFIX: testRateLimitPrefix,
    // Real Ollama embeddings are exercised end to end (OLLAMA_HOST stays live), but chat
    // generation is disabled so answers stay deterministic/extractive for assertions below -
    // OLLAMA_MODEL follows the same explicit-empty-disables convention as OLLAMA_HOST.
    OLLAMA_MODEL: '',
    ANTHROPIC_API_KEY: '',
    // Rate-limit counters live in Redis, not this test's scratch DB, so they persist across
    // separate `npm test` runs within the same window - effectively unlimited here so ordinary
    // functional tests (which upload/query far more than a real user would in 15 minutes) never
    // trip a limiter. The dedicated rate-limit test below spawns its own process with low
    // thresholds instead, so the actual throttling behavior still gets exercised for real.
    LOGIN_RATE_LIMIT_MAX: '100000',
    LLM_RATE_LIMIT_MAX: '100000',
    UPLOAD_RATE_LIMIT_MAX: '100000',
    REBUILD_RATE_LIMIT_MAX: '100000'
  };

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...sharedProcessEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  workerProcess = spawn(process.execPath, ['worker.js'], {
    cwd: process.cwd(),
    env: sharedProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await waitForServer();
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: testUsername, password: testPassword })
  });
  ({ token: authToken } = await login.json());
});

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

async function request(path, options = {}) {
  const headers = { authorization: `Bearer ${authToken}`, ...(options.headers || {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function pollUntil(fn, predicate, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil timed out; last value: ${JSON.stringify(last)}`);
}

async function extractAndIndex(documentId) {
  await request(`/api/documents/${documentId}/extract`, { method: 'POST' });
  await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['extracted', 'failed'].includes(result.body.document.status)
  );
  await request(`/api/documents/${documentId}/index`, { method: 'POST' });
  await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['indexed', 'failed'].includes(result.body.document.embeddingStatus)
  );
}

test('a request with no Authorization header is rejected', async () => {
  const { response } = await request('/api/documents', { headers: { authorization: '' } });
  assert.equal(response.status, 401);
});

test('a request with an invalid token is rejected', async () => {
  const { response } = await request('/api/documents', { headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(response.status, 401);
});

test('a request with an expired token is rejected', async () => {
  const expiredToken = jwt.sign({ sub: 'user_1', username: testUsername }, testJwtSecret, { expiresIn: -10 });
  const { response } = await request('/api/documents', { headers: { authorization: `Bearer ${expiredToken}` } });
  assert.equal(response.status, 401);
});

test('login rejects the wrong password', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: testUsername, password: 'wrong-password' })
  });
  assert.equal(response.status, 401);
});

test('login with correct credentials returns a usable token', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: testUsername, password: testPassword })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const authed = await fetch(`${baseUrl}/api/documents`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authed.status, 200);
});

test('GET /api/health stays exempt from auth', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.checks, { database: true, objectStorage: true, redis: true });
});

test('GET /metrics returns Prometheus-format output', async () => {
  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  const body = await response.text();
  assert.match(body, /http_request_duration_seconds/);
  assert.match(body, /job_queue_depth/);
});

test('document intelligence workflow completes end to end', async () => {
  await waitForServer();

  const form = new FormData();
  form.append('file', new Blob(['Supplier dependency is the highest procurement risk.'], { type: 'text/plain' }), 'day18-test.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  assert.equal(upload.response.status, 201);
  const documentId = upload.body.document.id;

  const extraction = await request(`/api/documents/${documentId}/extract`, { method: 'POST' });
  assert.equal(extraction.response.status, 202);
  const extracted = await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['extracted', 'failed'].includes(result.body.document.status)
  );
  assert.equal(extracted.body.document.status, 'extracted');

  const indexing = await request(`/api/documents/${documentId}/index`, { method: 'POST' });
  assert.equal(indexing.response.status, 202);
  const indexed = await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['indexed', 'failed'].includes(result.body.document.embeddingStatus)
  );
  assert.equal(indexed.body.document.embeddingStatus, 'indexed');
  const indexedChunks = await request(`/api/documents/${documentId}/chunks`);
  assert.ok(indexedChunks.body.chunks[0].embedding.length > 0);

  const question = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the procurement risk?' })
  });
  assert.equal(question.response.status, 201);
  assert.equal(question.body.status, 'completed');
  assert.equal(question.body.citations[0].documentId, documentId);

  const report = await request('/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Day 18 test report',
      documentIds: [documentId],
      queryIds: [question.body.id]
    })
  });
  assert.equal(report.response.status, 201);

  const downloadedReport = await fetch(`${baseUrl}${report.body.downloadUrl}`, {
    headers: { authorization: `Bearer ${authToken}` }
  });
  assert.equal(downloadedReport.status, 200);
  assert.match(await downloadedReport.text(), /Day 18 test report/);

  const deleted = await request(`/api/documents/${documentId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 204);
});

test('validation and negative paths return safe errors', async () => {
  await waitForServer();

  const missingFile = await request('/api/documents', { method: 'POST', body: new FormData() });
  assert.equal(missingFile.response.status, 400);

  const unsupportedForm = new FormData();
  unsupportedForm.append('file', new Blob(['not supported'], { type: 'application/octet-stream' }), 'malware.exe');
  const unsupportedUpload = await request('/api/documents', { method: 'POST', body: unsupportedForm });
  assert.equal(unsupportedUpload.response.status, 400);

  const emptyQuestion = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '   ' })
  });
  assert.equal(emptyQuestion.response.status, 400);

  const emptySearch = await request('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '' })
  });
  assert.equal(emptySearch.response.status, 400);

  const emptyReport = await request('/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(emptyReport.response.status, 400);

  const missingDocument = await request('/api/documents/doc_missing/chunks');
  assert.equal(missingDocument.response.status, 404);

  const textForm = new FormData();
  textForm.append('file', new Blob(['plain text'], { type: 'text/plain' }), 'ocr-not-supported.txt');
  const textUpload = await request('/api/documents', { method: 'POST', body: textForm });
  const textDocumentId = textUpload.body.document.id;
  const unsupportedOcr = await request(`/api/documents/${textDocumentId}/ocr`, { method: 'POST' });
  assert.equal(unsupportedOcr.response.status, 422);

  await request(`/api/documents/${textDocumentId}`, { method: 'DELETE' });
});

test('GET /api/documents paginates with limit/offset and reports an accurate total', async () => {
  await waitForServer();

  // Baseline first, since the shared test DB accumulates rows from other tests in this file -
  // asserting a delta rather than an absolute total keeps this robust regardless of test order.
  const before = await request('/api/documents?limit=1&offset=0');
  const baselineTotal = before.body.total;

  const uploadedIds = [];
  for (let i = 0; i < 3; i += 1) {
    const form = new FormData();
    form.append('file', new Blob([`Pagination test document ${i}.`], { type: 'text/plain' }), `pagination-${i}.txt`);
    const upload = await request('/api/documents', { method: 'POST', body: form });
    uploadedIds.push(upload.body.document.id);
  }

  const afterUpload = await request('/api/documents?limit=1&offset=0');
  assert.equal(afterUpload.body.total, baselineTotal + 3, 'total must reflect every row, not just the current page');

  const fullLimit = baselineTotal + 3;
  const page1 = await request(`/api/documents?limit=${Math.ceil(fullLimit / 2)}&offset=0`);
  const page2 = await request(`/api/documents?limit=${fullLimit}&offset=${page1.body.documents.length}`);
  assert.equal(page1.body.documents.length, Math.min(Math.ceil(fullLimit / 2), fullLimit));
  const combinedIds = [...page1.body.documents, ...page2.body.documents].map((document) => document.id);
  assert.equal(new Set(combinedIds).size, combinedIds.length, 'paginated results must not overlap across pages');
  for (const id of uploadedIds) assert.ok(combinedIds.includes(id), `uploaded document ${id} must appear exactly once across all pages`);

  assert.ok(Number.isInteger(afterUpload.body.indexedCount) && afterUpload.body.indexedCount >= 0);

  for (const id of uploadedIds) await request(`/api/documents/${id}`, { method: 'DELETE' });
});

test('GET /api/reports paginates with limit/offset and reports an accurate total', async () => {
  await waitForServer();

  const form = new FormData();
  form.append('file', new Blob(['Pagination test source document.'], { type: 'text/plain' }), 'pagination-report-source.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  const documentId = upload.body.document.id;

  const before = await request('/api/reports?limit=1&offset=0');
  const baselineTotal = before.body.total;

  const createdReportIds = [];
  for (let i = 0; i < 2; i += 1) {
    const report = await request('/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `Pagination test report ${i}`, documentIds: [documentId] })
    });
    createdReportIds.push(report.body.id);
  }

  const afterCreate = await request('/api/reports?limit=1&offset=0');
  assert.equal(afterCreate.body.total, baselineTotal + 2, 'total must reflect every row, not just the current page');

  const onlyFirst = await request('/api/reports?limit=1&offset=0');
  assert.equal(onlyFirst.body.reports.length, 1);
  assert.equal(onlyFirst.body.limit, 1);
  assert.equal(onlyFirst.body.offset, 0);

  await request(`/api/documents/${documentId}`, { method: 'DELETE' });
});

test('concurrent extraction does not lose document updates', async () => {
  await waitForServer();

  const uploads = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const form = new FormData();
      form.append('file', new Blob([`Concurrent test document number ${i}.`], { type: 'text/plain' }), `concurrent-${i}.txt`);
      return request('/api/documents', { method: 'POST', body: form });
    })
  );
  const documentIds = uploads.map((upload) => upload.body.document.id);

  const extractions = await Promise.all(documentIds.map((id) => request(`/api/documents/${id}/extract`, { method: 'POST' })));
  for (const extraction of extractions) assert.equal(extraction.response.status, 202);

  const settled = await Promise.all(documentIds.map((id) => pollUntil(
    () => request(`/api/documents/${id}`),
    (result) => ['extracted', 'failed'].includes(result.body.document.status)
  )));
  const notExtracted = settled.filter((result) => result.body.document.status !== 'extracted');
  assert.equal(notExtracted.length, 0, 'every concurrently-extracted document must persist as extracted, not be clobbered by a sibling request');

  await Promise.all(documentIds.map((id) => request(`/api/documents/${id}`, { method: 'DELETE' })));
});

test('re-indexing an already-indexed document runs a new job instead of sticking at queued', async () => {
  await waitForServer();

  const form = new FormData();
  form.append('file', new Blob(['Re-index regression document about warehouse capacity.'], { type: 'text/plain' }), 'reindex.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  const documentId = upload.body.document.id;
  await extractAndIndex(documentId);

  // The first index job is now completed but still retained in Redis under jobId === documentId.
  // A plain queue.add() with that jobId would return the stale job and nothing would ever run.
  const reindexing = await request(`/api/documents/${documentId}/index`, { method: 'POST' });
  assert.equal(reindexing.response.status, 202);
  const reindexed = await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['indexed', 'failed'].includes(result.body.document.embeddingStatus)
  );
  assert.equal(reindexed.body.document.embeddingStatus, 'indexed');

  const rebuild = await request('/api/index/rebuild', { method: 'POST' });
  assert.equal(rebuild.response.status, 202);
  const rebuilt = await pollUntil(
    () => request(`/api/documents/${documentId}`),
    (result) => ['indexed', 'failed'].includes(result.body.document.embeddingStatus)
  );
  assert.equal(rebuilt.body.document.embeddingStatus, 'indexed');

  await request(`/api/documents/${documentId}`, { method: 'DELETE' });
});

test('retrieval favors the topically relevant chunk over a lexically noisy one', async () => {
  await waitForServer();

  const longIrrelevantChunk = 'The '.repeat(400) + 'quarterly office newsletter covered parking updates and cafeteria menus.';
  const shortRelevantChunk = 'Supplier dependency is the highest procurement risk this quarter.';
  const form = new FormData();
  form.append('file', new Blob([`${longIrrelevantChunk}\n\n${shortRelevantChunk}`], { type: 'text/plain' }), 'scoring-regression.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  const documentId = upload.body.document.id;
  await extractAndIndex(documentId);

  const question = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the procurement risk?' })
  });
  assert.equal(question.body.status, 'completed');
  assert.match(question.body.citations[0].excerpt, /procurement risk/, 'the relevant chunk must outrank a longer chunk that is only stopword-dense');

  await request(`/api/documents/${documentId}`, { method: 'DELETE' });
});

test('duplicate chunk content is not repeated in a single answer', async () => {
  await waitForServer();

  const text = 'Employee retention improved after the flexible remote work policy launched.';
  const uploadOne = await request('/api/documents', {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new Blob([text], { type: 'text/plain' }), 'dup-a.txt'); return f; })()
  });
  const uploadTwo = await request('/api/documents', {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new Blob([text], { type: 'text/plain' }), 'dup-b.txt'); return f; })()
  });
  const idA = uploadOne.body.document.id;
  const idB = uploadTwo.body.document.id;
  for (const id of [idA, idB]) {
    await extractAndIndex(id);
  }

  const question = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What happened with employee retention?' })
  });
  assert.equal(question.body.status, 'completed');
  const occurrences = question.body.answer.split('remote work policy').length - 1;
  assert.equal(occurrences, 1, 'identical content from two duplicate uploads must not be repeated in one answer');

  await request(`/api/documents/${idA}`, { method: 'DELETE' });
  await request(`/api/documents/${idB}`, { method: 'DELETE' });
});

test('malformed request bodies get safe generic errors, not leaked internals', async () => {
  await waitForServer();

  const malformedJson = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"question": "broken'
  });
  assert.equal(malformedJson.status, 400);
  const malformedBody = await malformedJson.json();
  assert.equal(malformedBody.error, 'The request body could not be parsed');

  const oversized = await fetch(`${baseUrl}/api/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'a '.repeat(100000) })
  });
  assert.equal(oversized.status, 413);
  const oversizedBody = await oversized.json();
  assert.equal(oversizedBody.error, 'Request payload is too large');
});

test('oversized documentIds/queryIds arrays and long questions are rejected', async () => {
  await waitForServer();

  const tooManyIds = Array.from({ length: 101 }, (_, i) => `doc_${i}`);
  const tooManyDocIds = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'test', documentIds: tooManyIds })
  });
  assert.equal(tooManyDocIds.response.status, 400);

  const tooLongQuestion = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'a'.repeat(2001) })
  });
  assert.equal(tooLongQuestion.response.status, 400);

  const tooManyCases = await request('/api/search/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cases: Array.from({ length: 21 }, () => ({ query: 'test' })) })
  });
  assert.equal(tooManyCases.response.status, 400);
});

test('security headers are present and the origin allowlist is enforced', async () => {
  await waitForServer();

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy'), 'CSP header must be present');
  assert.equal(response.headers.get('x-powered-by'), null);

  const disallowedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://evil.example.com' } });
  assert.notEqual(disallowedOrigin.headers.get('access-control-allow-origin'), 'http://evil.example.com');
});

test('a NUL byte in user input does not crash the server', async () => {
  await waitForServer();

  // Postgres rejects a NUL byte (0x00) in any text parameter as an encoding error; left
  // unsanitized, that error was an uncaught rejection that took the entire process down for
  // every concurrent user, not just the one bad request - discovered live, not hypothesized.
  const question = await request('/api/questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'revenue\u0000test' })
  });
  assert.equal(question.response.status, 201);
  assert.ok(!question.body.question.includes('\u0000'), 'the NUL byte must be stripped, not merely tolerated');

  // The server must still be responsive right after - this is the property that actually matters.
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
});

test('an unreachable database degrades to a clean error instead of crashing the process', async () => {
  // Express 4 does not forward a rejected promise from an async route handler to error-handling
  // middleware on its own - an uncaught rejection crashes the whole process. This happened live,
  // twice (a Postgres error, then a MinIO outage), each taking down every concurrent user's
  // request, not just the failing one. Reproduced here without needing a real outage: point a
  // fresh server instance at an address nothing is listening on.
  const brokenPort = 4102;
  const brokenProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(brokenPort),
      DATABASE_URL: 'postgresql://amplify:amplify@localhost:1/nonexistent',
      OBJECT_STORE_ENDPOINT: 'http://localhost:1',
      REDIS_URL: 'redis://localhost:1',
      JWT_SECRET: testJwtSecret,
      OLLAMA_HOST: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const brokenBaseUrl = `http://localhost:${brokenPort}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch(`${brokenBaseUrl}/api/health`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const health = await fetch(`${brokenBaseUrl}/api/health`);
    assert.equal(health.status, 200, 'the process must start and answer health checks even with unreachable infra');
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'degraded', 'the top-level status must reflect a real dependency outage, not always say ok');
    assert.equal(healthBody.checks.database, false);
    assert.equal(healthBody.checks.objectStorage, false);
    assert.equal(healthBody.checks.redis, false);

    // requireAuth never queries the database (it only verifies the JWT signature/expiry), so a
    // minted-but-unregistered token is enough here - this also doubles as a regression guard for
    // that constraint, since a future change that added a DB lookup would make this hang/500
    // instead of cleanly reaching the assertion below.
    const brokenToken = jwt.sign({ sub: 'broken-test' }, testJwtSecret);
    const listDocuments = await fetch(`${brokenBaseUrl}/api/documents`, {
      headers: { authorization: `Bearer ${brokenToken}` }
    });
    assert.equal(listDocuments.status, 500, 'a real DB-dependent route must degrade to a clean 500');
    const errorBody = await listDocuments.json();
    assert.equal(errorBody.error, 'Internal server error');

    const stillAlive = await fetch(`${brokenBaseUrl}/api/health`);
    assert.equal(stillAlive.status, 200, 'the process must still be alive after the failed request');
  } finally {
    brokenProcess.kill('SIGTERM');
    await once(brokenProcess, 'exit');
  }
});

test('repeated failed logins are rate limited', async () => {
  // A dedicated instance with a low threshold and its own Redis key prefix - isolated from the
  // shared serverProcess's counters (which are set effectively unlimited above specifically so
  // this test's deliberate exhaustion doesn't bleed into every other test that calls /auth/login).
  const rateLimitedPort = 4103;
  const rateLimitedBaseUrl = `http://localhost:${rateLimitedPort}`;
  const rateLimitedProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(rateLimitedPort),
      DATABASE_URL: testDatabaseUrl,
      OBJECT_STORE_BUCKET: testBucket,
      JWT_SECRET: testJwtSecret,
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      QUEUE_PREFIX: testQueuePrefix,
      RATE_LIMIT_KEY_PREFIX: `${testRateLimitPrefix}_dedicated`,
      LOGIN_RATE_LIMIT_MAX: '3',
      OLLAMA_MODEL: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch(`${rateLimitedBaseUrl}/api/health`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${rateLimitedBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: testUsername, password: 'wrong-password' })
      });
      assert.equal(response.status, 401, `attempt ${attempt} should fail on credentials, not be rate limited yet`);
    }

    const throttled = await fetch(`${rateLimitedBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: 'wrong-password' })
    });
    assert.equal(throttled.status, 429);
    assert.ok(throttled.headers.get('ratelimit-limit'), 'RateLimit-* headers must be present on a throttled response');
  } finally {
    rateLimitedProcess.kill('SIGTERM');
    await once(rateLimitedProcess, 'exit');
  }
});

after(async () => {
  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit');
  workerProcess.kill('SIGTERM');
  await once(workerProcess, 'exit');
  await closePool();

  // CI's Redis is ephemeral per-run, but a local dev Redis is long-lived - without this, repeated
  // local `npm test` runs would leave orphaned BullMQ keys under a fresh testQueuePrefix forever.
  const Redis = (await import('ioredis')).default;
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const keys = [
    ...(await redis.keys(`${testQueuePrefix}:*`)),
    ...(await redis.keys(`${testRateLimitPrefix}*`))
  ];
  if (keys.length) await redis.del(...keys);
  await redis.quit();

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'amplify', secretAccessKey: 'amplify123' }
  });
  const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: testBucket }));
  for (const object of Contents || []) {
    await s3.send(new DeleteObjectCommand({ Bucket: testBucket, Key: object.Key }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket: testBucket }));

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE ${testDbName} WITH (FORCE)`);
  await admin.end();
});
