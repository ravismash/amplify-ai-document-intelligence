import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { connection, QUEUE_PREFIX, extractConcurrency, ocrConcurrency, indexConcurrency } from './queue.js';
import { withRetry, extractDocument, ocrDocument, indexDocumentChunks, persistChunks } from './processing.js';
import * as documentsDb from './db/documents.js';
import * as extractionsDb from './db/extractions.js';
import { closePool } from './db/pool.js';
import { logEvent } from './logger.js';

async function handleExtractLike({ documentId, method }) {
  const document = await documentsDb.getDocumentById(documentId);
  if (!document) return; // deleted while queued - nothing to do
  await documentsDb.updateDocument(documentId, { status: 'extracting', updatedAt: new Date().toISOString(), error: null });
  try {
    const result = method === 'ocr'
      ? await withRetry(() => ocrDocument(document.storageName))
      : await withRetry(() => extractDocument(document.storageName, document.mimeType));
    await extractionsDb.upsertExtraction({
      documentId,
      status: 'completed',
      method: method === 'ocr' ? 'ocr' : undefined,
      text: result.text,
      pages: result.pages,
      error: null,
      extractedAt: new Date().toISOString()
    });
    const chunks = await persistChunks(documentId, result.pages);
    await documentsDb.updateDocument(documentId, {
      status: 'extracted',
      pageCount: method === 'ocr' ? 1 : result.pages.length,
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    await documentsDb.updateDocument(documentId, { status: 'failed', error: error.message, updatedAt: new Date().toISOString() });
    throw error;
  }
}

async function handleIndex({ documentId }) {
  const document = await documentsDb.getDocumentById(documentId);
  if (!document) return;
  await documentsDb.updateDocument(documentId, { embeddingStatus: 'processing', updatedAt: new Date().toISOString() });
  try {
    const chunks = await indexDocumentChunks(documentId);
    await documentsDb.updateDocument(documentId, {
      status: 'ready',
      embeddingStatus: 'indexed',
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
      error: null
    });
  } catch (error) {
    await documentsDb.updateDocument(documentId, { embeddingStatus: 'failed', error: error.message, updatedAt: new Date().toISOString() });
    throw error;
  }
}

const workers = [
  new Worker('extract', (job) => handleExtractLike({ documentId: job.data.documentId, method: 'extract' }), { connection, prefix: QUEUE_PREFIX, concurrency: extractConcurrency }),
  new Worker('ocr', (job) => handleExtractLike({ documentId: job.data.documentId, method: 'ocr' }), { connection, prefix: QUEUE_PREFIX, concurrency: ocrConcurrency }),
  new Worker('index', (job) => handleIndex({ documentId: job.data.documentId }), { connection, prefix: QUEUE_PREFIX, concurrency: indexConcurrency })
];

for (const worker of workers) {
  worker.on('failed', (job, error) => logEvent('job_failed', { queue: worker.name, jobId: job?.id, documentId: job?.data?.documentId, error: error.message }));
  worker.on('completed', (job) => logEvent('job_completed', { queue: worker.name, jobId: job.id, documentId: job.data.documentId }));
}

logEvent('worker_started', { extractConcurrency, ocrConcurrency, indexConcurrency });

async function shutdown(signal) {
  logEvent('worker_shutdown_started', { signal });
  await Promise.all(workers.map((worker) => worker.close()));
  await closePool();
  logEvent('worker_shutdown_completed');
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
