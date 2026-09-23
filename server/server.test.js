import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import pg from 'pg';
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { runMigrations } from './db/migrate.js';

const port = 4100;
const baseUrl = `http://localhost:${port}`;

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgresql://amplify:amplify@localhost:5432/postgres';
const testDbName = `amplify_ai_test_${randomUUID().replace(/-/g, '_')}`;
const testDatabaseUrl = adminUrl.replace(/\/[^/]*$/, `/${testDbName}`);
const testBucket = `documents-test-${randomUUID()}`;

let serverProcess;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testDatabaseUrl);

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    credentials: { accessKeyId: 'amplify', secretAccessKey: 'amplify123' }
  });
  await s3.send(new CreateBucketCommand({ Bucket: testBucket }));

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl,
      OBJECT_STORE_BUCKET: testBucket,
      OLLAMA_HOST: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
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

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test('document intelligence workflow completes end to end', async () => {
  await waitForServer();

  const form = new FormData();
  form.append('file', new Blob(['Supplier dependency is the highest procurement risk.'], { type: 'text/plain' }), 'day18-test.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  assert.equal(upload.response.status, 201);
  const documentId = upload.body.document.id;

  const extraction = await request(`/api/documents/${documentId}/extract`, { method: 'POST' });
  assert.equal(extraction.response.status, 200);
  assert.equal(extraction.body.document.status, 'extracted');

  const indexing = await request(`/api/documents/${documentId}/index`, { method: 'POST' });
  assert.equal(indexing.response.status, 200);
  assert.equal(indexing.body.document.embeddingStatus, 'indexed');
  assert.ok(indexing.body.chunks[0].embedding.length > 0);

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

  const downloadedReport = await fetch(`${baseUrl}${report.body.downloadUrl}`);
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

  await Promise.all(documentIds.map((id) => request(`/api/documents/${id}/extract`, { method: 'POST' })));

  const refetched = await Promise.all(documentIds.map((id) => request(`/api/documents/${id}`)));
  const stillExtracting = refetched.filter((item) => item.body.document.status !== 'extracted');
  assert.equal(stillExtracting.length, 0, 'every concurrently-extracted document must persist as extracted, not be clobbered by a sibling request');

  await Promise.all(documentIds.map((id) => request(`/api/documents/${id}`, { method: 'DELETE' })));
});

test('retrieval favors the topically relevant chunk over a lexically noisy one', async () => {
  await waitForServer();

  const longIrrelevantChunk = 'The '.repeat(400) + 'quarterly office newsletter covered parking updates and cafeteria menus.';
  const shortRelevantChunk = 'Supplier dependency is the highest procurement risk this quarter.';
  const form = new FormData();
  form.append('file', new Blob([`${longIrrelevantChunk}\n\n${shortRelevantChunk}`], { type: 'text/plain' }), 'scoring-regression.txt');
  const upload = await request('/api/documents', { method: 'POST', body: form });
  const documentId = upload.body.document.id;
  await request(`/api/documents/${documentId}/extract`, { method: 'POST' });
  await request(`/api/documents/${documentId}/index`, { method: 'POST' });

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
    await request(`/api/documents/${id}/extract`, { method: 'POST' });
    await request(`/api/documents/${id}/index`, { method: 'POST' });
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
    assert.equal(healthBody.checks.database, false);
    assert.equal(healthBody.checks.objectStorage, false);

    const listDocuments = await fetch(`${brokenBaseUrl}/api/documents`);
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

after(async () => {
  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit');

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
