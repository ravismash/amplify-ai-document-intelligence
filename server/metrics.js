import client from '@prometheus-io/client';
import { extractQueue, ocrQueue, indexQueue } from './queue.js';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register]
});

const queueDepth = new client.Gauge({
  name: 'job_queue_depth',
  help: 'Number of jobs per queue and state',
  labelNames: ['queue', 'state'],
  registers: [register]
});

const queues = { extract: extractQueue, ocr: ocrQueue, index: indexQueue };

export async function refreshQueueMetrics() {
  for (const [name, queue] of Object.entries(queues)) {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    for (const [state, count] of Object.entries(counts)) {
      queueDepth.set({ queue: name, state }, count);
    }
  }
}
