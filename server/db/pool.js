import pg from 'pg';
import { registerTypes } from 'pgvector/pg';
import { stripNulls } from './sanitize.js';

// pg.Pool's 'connect' event doesn't let listeners delay handing the client out, so registering
// pgvector's type parser there races the first query on a freshly-opened connection. Overriding
// connect() on a Client subclass instead makes type registration part of the connection handshake
// itself, so the pool never considers a client ready until it's done.
//
// query() is overridden on the same class for a different reason: a NUL byte (0x00) anywhere in a
// text parameter makes Postgres reject the query with an encoding error that, left unhandled,
// crashes the whole process - not just the one request (this actually happened: a single question
// containing a NUL byte took the live server down). Every pool.query() call and every manually
// checked-out transaction client (pool.connect()) is an instance of this class, so sanitizing here
// is the one place that guarantees no caller - current or future - can bypass it.
class VectorAwareClient extends pg.Client {
  async connect(callback) {
    if (callback) {
      super.connect((error) => {
        if (error) return callback(error);
        registerTypes(this).then(() => callback(), callback);
      });
      return undefined;
    }
    await super.connect();
    await registerTypes(this);
    return undefined;
  }

  query(config, values, callback) {
    if (typeof config === 'string' && Array.isArray(values)) {
      return super.query(config, stripNulls(values), callback);
    }
    return super.query(config, values, callback);
  }
}

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, Client: VectorAwareClient });
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
