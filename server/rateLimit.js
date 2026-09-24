import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// Distinct from BullMQ's QUEUE_PREFIX - namespaces rate-limit counters so a test run (or a second
// environment sharing one Redis) doesn't share counters with anything else hitting the same keys.
const KEY_PREFIX = process.env.RATE_LIMIT_KEY_PREFIX || 'rl';
// Positional-URL form, not { url: ... } - ioredis silently ignores a `url` key inside an options
// object and falls back to its own defaults (discovered the hard way wiring up the Phase 5 health
// check). This is a dedicated client for rate-limit bookkeeping, separate from BullMQ's queues.
const rateLimitClient = new Redis(REDIS_URL);
rateLimitClient.on('error', () => {});

function makeLimiter({ windowMs, max, prefix }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests, please try again later' }),
    store: new RedisStore({
      sendCommand: (command, ...args) => rateLimitClient.call(command, ...args),
      prefix
    })
  });
}

export const loginLimiter = makeLimiter({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
  prefix: `${KEY_PREFIX}:login:`
});

export const llmRouteLimiter = makeLimiter({
  windowMs: Number(process.env.LLM_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LLM_RATE_LIMIT_MAX) || 60,
  prefix: `${KEY_PREFIX}:llm:`
});

export const uploadLimiter = makeLimiter({
  windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 30,
  prefix: `${KEY_PREFIX}:upload:`
});

export const rebuildLimiter = makeLimiter({
  windowMs: Number(process.env.REBUILD_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.REBUILD_RATE_LIMIT_MAX) || 5,
  prefix: `${KEY_PREFIX}:rebuild:`
});
