import { toSql } from 'pgvector/pg';
import { getPool } from './pool.js';

function rowToChunk(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    text: row.text,
    pageNumber: row.page_number,
    section: row.section,
    chunkIndex: row.chunk_index,
    characterStart: row.character_start,
    characterEnd: row.character_end,
    embeddingStatus: row.embedding_status,
    ...(row.embedding !== undefined ? { embedding: row.embedding } : {}),
    ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}),
    ...(row.embedding_dimensions !== null && row.embedding_dimensions !== undefined ? { embeddingDimensions: row.embedding_dimensions } : {}),
    ...(row.indexed_at ? { indexedAt: row.indexed_at.toISOString() } : {})
  };
}

// Transactional delete-all-then-insert for one document's chunks — strictly safer than the old
// JSON version (read-all/filter/write-all with no atomicity at all between steps).
export async function replaceChunksForDocument(documentId, chunkRecords) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
    for (const chunk of chunkRecords) {
      await client.query(
        `INSERT INTO chunks (id, document_id, text, page_number, section, chunk_index, character_start, character_end, embedding_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [chunk.id, chunk.documentId, chunk.text, chunk.pageNumber, chunk.section,
          chunk.chunkIndex, chunk.characterStart, chunk.characterEnd, chunk.embeddingStatus]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return chunkRecords;
}

export async function getChunksByDocumentId(documentId) {
  const { rows } = await getPool().query('SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
  return rows.map(rowToChunk);
}

// Sets embedding/model/dimensions/status for each chunk. The embedding VALUES themselves are
// computed by the caller (server.js keeps the exact same createDemoEmbedding algorithm) — this
// module only persists them.
export async function setChunkEmbeddings(embeddedChunks) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const chunk of embeddedChunks) {
      await client.query(
        `UPDATE chunks SET embedding = $2, embedding_model = $3, embedding_dimensions = $4,
           embedding_status = 'indexed', indexed_at = $5
         WHERE id = $1`,
        [chunk.id, toSql(chunk.embedding), chunk.embeddingModel, chunk.embeddingDimensions, chunk.indexedAt]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Candidate rows for searchChunks() in server.js, which runs the unchanged JS ranking pipeline
// (cosine + lexical overlap + dedup) over whatever this returns. Postgres/pgvector is used here
// purely as a typed, durable store — not yet as the ranking engine.
export async function getIndexedChunks(documentIds) {
  const { rows } = await getPool().query(
    `SELECT * FROM chunks WHERE embedding_status = 'indexed' AND embedding IS NOT NULL
       AND ($1::text[] IS NULL OR document_id = ANY($1))`,
    [documentIds]
  );
  return rows.map(rowToChunk);
}
