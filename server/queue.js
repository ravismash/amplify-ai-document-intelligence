import { Queue } from 'bullmq';
import Redis from 'ioredis';

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

// Using documentId as the job's custom jobId is meant to stop two near-simultaneous requests from
// double-enqueueing the same not-yet-processed document. But BullMQ treats a jobId as "taken" for
// as long as the job record exists at all - including a *completed* one still sitting in Redis
// under removeOnComplete's retention window - so a plain `.add()` with the same jobId after a
// prior run finished silently returns that stale completed job instead of enqueueing new work.
// Discovered live: re-running /api/index/rebuild on an already-indexed corpus left every document
// stuck showing embeddingStatus 'queued' forever, because no job ever actually ran again. Only
// remove-and-recreate when the existing job is in a terminal state (completed/failed) - a job
// that's still waiting/active/delayed is exactly the in-flight case the dedup is supposed to catch,
// so it's left alone and `.add()` naturally returns that existing job without creating a duplicate.
export async function enqueueUnique(queue, jobName, documentId) {
  const existingJob = await queue.getJob(documentId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'completed' || state === 'failed') {
      await existingJob.remove();
    }
  }
  return queue.add(jobName, { documentId }, { jobId: documentId });
}

export const extractConcurrency = Number(process.env.EXTRACT_QUEUE_CONCURRENCY) || 2;
export const ocrConcurrency = Number(process.env.OCR_QUEUE_CONCURRENCY) || 2;
export const indexConcurrency = Number(process.env.INDEX_QUEUE_CONCURRENCY) || 1;

// A dedicated client, not one borrowed from a Queue instance - queue.client isn't part of
// BullMQ's public API and resolved to undefined when tried here. ioredis's options-object form
// silently ignores a `url` key (falls back to its own defaults) - BullMQ's own RedisConnection
// works around this internally by extracting `url` and passing it positionally; do the same here.
// Unlike the queues' connection (which needs maxRetriesPerRequest: null for BullMQ's blocking
// commands), a health-check ping must fail fast - a hung health check is worse than a missing one.
const healthCheckClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
healthCheckClient.on('error', () => {}); // failures surface through ping() rejecting below, not this event

export async function closeQueues() {
  await Promise.all([extractQueue.close(), ocrQueue.close(), indexQueue.close(), healthCheckClient.quit()]);
}

export async function checkRedisHealth() {
  try {
    await healthCheckClient.ping();
    return true;
  } catch {
    return false;
  }
}
