import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import pg from 'pg';
import { runMigrations } from './migrate.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || 'postgresql://amplify:amplify@localhost:5432/postgres';
const dbName = `amplify_ai_test_${randomUUID().replace(/-/g, '_')}`;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const testUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testUrl);
});

after(async () => {
  const { closePool } = await import('./pool.js');
  await closePool();

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('document insert/get/update round-trips correctly', async () => {
  const { insertDocument, getDocumentById, updateDocument } = await import('./documents.js');
  const now = new Date().toISOString();
  const doc = await insertDocument({
    id: `doc_${randomUUID()}`, name: 'smoke.txt', mimeType: 'text/plain', sizeBytes: 10,
    status: 'uploaded', uploadedAt: now, updatedAt: now, pageCount: null, error: null, storageName: 'key1'
  });
  assert.equal(doc.status, 'uploaded');

  const fetched = await getDocumentById(doc.id);
  assert.equal(fetched.name, 'smoke.txt');

  const updated = await updateDocument(doc.id, { status: 'extracted', pageCount: 3 });
  assert.equal(updated.status, 'extracted');
  assert.equal(updated.pageCount, 3);
  assert.equal(updated.name, 'smoke.txt', 'fields not in the patch must be untouched');
});

test('concurrent updateDocument calls on the same row do not clobber each other', async () => {
  const { insertDocument, updateDocument, getDocumentById } = await import('./documents.js');
  const now = new Date().toISOString();
  const doc = await insertDocument({
    id: `doc_${randomUUID()}`, name: 'concurrent.txt', mimeType: 'text/plain', sizeBytes: 10,
    status: 'uploaded', uploadedAt: now, updatedAt: now, pageCount: null, error: null, storageName: 'key2'
  });

  // Six concurrent calls, each patching a DIFFERENT single column. A targeted `UPDATE ... SET
  // col = $2 WHERE id = $1` never touches the other five columns, so all six changes must survive
  // regardless of commit order. A stale read-mutate-write (the original JSON-file bug class,
  // recreated by reading the row, merging in JS, then writing every column back) WOULD lose
  // whichever of these landed before the slowest reader's stale snapshot was taken — this is the
  // property that actually distinguishes the two implementations, unlike a same-field race.
  await Promise.all([
    updateDocument(doc.id, { status: 'ready' }),
    updateDocument(doc.id, { error: 'concurrent-marker' }),
    updateDocument(doc.id, { pageCount: 7 }),
    updateDocument(doc.id, { chunkCount: 9 }),
    updateDocument(doc.id, { embeddingStatus: 'indexed' }),
    updateDocument(doc.id, { storageName: 'concurrent-key' })
  ]);

  const final = await getDocumentById(doc.id);
  assert.equal(final.status, 'ready', 'concurrent status update must not be lost');
  assert.equal(final.error, 'concurrent-marker', 'concurrent error update must not be lost');
  assert.equal(final.pageCount, 7, 'concurrent pageCount update must not be lost');
  assert.equal(final.chunkCount, 9, 'concurrent chunkCount update must not be lost');
  assert.equal(final.embeddingStatus, 'indexed', 'concurrent embeddingStatus update must not be lost');
  assert.equal(final.storageName, 'concurrent-key', 'concurrent storageName update must not be lost');
});

test('extraction upsert keeps exactly one row per document', async () => {
  const { insertDocument } = await import('./documents.js');
  const { upsertExtraction, getExtractionByDocumentId } = await import('./extractions.js');
  const now = new Date().toISOString();
  const doc = await insertDocument({
    id: `doc_${randomUUID()}`, name: 'ext.txt', mimeType: 'text/plain', sizeBytes: 10,
    status: 'uploaded', uploadedAt: now, updatedAt: now, pageCount: null, error: null, storageName: 'key3'
  });

  await upsertExtraction({ documentId: doc.id, status: 'completed', text: 'first pass', pages: [{ pageNumber: 1, text: 'first pass', confidence: null }], error: null, extractedAt: now });
  await upsertExtraction({ documentId: doc.id, status: 'completed', text: 'second pass', pages: [{ pageNumber: 1, text: 'second pass', confidence: null }], error: null, extractedAt: now });

  const extraction = await getExtractionByDocumentId(doc.id);
  assert.equal(extraction.text, 'second pass', 're-extracting must overwrite, not duplicate');
});

test('chunks round-trip including embedding vector fidelity, and delete cascades', async () => {
  const { insertDocument, deleteDocument } = await import('./documents.js');
  const { replaceChunksForDocument, setChunkEmbeddings, getIndexedChunks, getChunksByDocumentId } = await import('./chunks.js');
  const now = new Date().toISOString();
  const doc = await insertDocument({
    id: `doc_${randomUUID()}`, name: 'chunks.txt', mimeType: 'text/plain', sizeBytes: 10,
    status: 'uploaded', uploadedAt: now, updatedAt: now, pageCount: null, error: null, storageName: 'key4'
  });

  const chunkId = `chunk_${randomUUID()}`;
  await replaceChunksForDocument(doc.id, [{
    id: chunkId, documentId: doc.id, text: 'hello world', pageNumber: 1, section: null,
    chunkIndex: 0, characterStart: 0, characterEnd: 11, embeddingStatus: 'pending'
  }]);

  const embedding = Array.from({ length: 768 }, (_, i) => Number((Math.sin(i) * 0.1).toFixed(6)));
  await setChunkEmbeddings([{ id: chunkId, embedding, embeddingModel: 'nomic-embed-text', embeddingDimensions: 768, indexedAt: now }]);

  const indexed = await getIndexedChunks(null);
  const match = indexed.find((c) => c.id === chunkId);
  assert.ok(match, 'chunk must be returned as an indexed candidate');
  assert.deepEqual(match.embedding.map((v) => Number(v.toFixed(6))), embedding, 'embedding values must round-trip exactly through pgvector');

  await deleteDocument(doc.id);
  const remaining = await getChunksByDocumentId(doc.id);
  assert.equal(remaining.length, 0, 'deleting the document must cascade-delete its chunks');
});

test('deleting a document leaves queries and reports that reference it untouched', async () => {
  const { insertDocument, deleteDocument } = await import('./documents.js');
  const { insertQuery, getQueryById } = await import('./queries.js');
  const now = new Date().toISOString();
  const doc = await insertDocument({
    id: `doc_${randomUUID()}`, name: 'ref.txt', mimeType: 'text/plain', sizeBytes: 10,
    status: 'uploaded', uploadedAt: now, updatedAt: now, pageCount: null, error: null, storageName: 'key5'
  });

  const query = await insertQuery({
    id: `query_${randomUUID()}`, question: 'test?', documentIds: [doc.id], status: 'completed',
    answer: 'yes', answerModel: null, evidence: [], citations: [{ documentId: doc.id }], createdAt: now
  });

  await deleteDocument(doc.id);

  const stillThere = await getQueryById(query.id);
  assert.ok(stillThere, 'query history must survive deletion of a document it referenced (soft reference, no FK)');
});
