import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
export const QUEUE_PREFIX = process.env.QUEUE_PREFIX || 'amplify';
export const connection = { url: REDIS_URL, maxRetriesPerRequest: null };

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 }
};

export const extractQueue = new Queue('extract', { connection, prefix: QUEUE_PREFIX, defaultJobOptions });
export const ocrQueue = new Queue('ocr', { connection, prefix: QUEUE_PREFIX, defaultJobOptions });
export const indexQueue = new Queue('index', { connection, prefix: QUEUE_PREFIX, defaultJobOptions });

export const extractConcurrency = Number(process.env.EXTRACT_QUEUE_CONCURRENCY) || 2;
export const ocrConcurrency = Number(process.env.OCR_QUEUE_CONCURRENCY) || 2;
export const indexConcurrency = Number(process.env.INDEX_QUEUE_CONCURRENCY) || 1;

export async function closeQueues() {
  await Promise.all([extractQueue.close(), ocrQueue.close(), indexQueue.close()]);
}
