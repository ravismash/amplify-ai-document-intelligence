import { getPool } from './pool.js';

function rowToDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    uploadedAt: row.uploaded_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    pageCount: row.page_count,
    error: row.error,
    storageName: row.storage_name,
    chunkCount: row.chunk_count,
    embeddingStatus: row.embedding_status
  };
}

export async function insertDocument(document) {
  const { rows } = await getPool().query(
    `INSERT INTO documents (id, name, mime_type, size_bytes, status, uploaded_at, updated_at, page_count, error, storage_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [document.id, document.name, document.mimeType, document.sizeBytes, document.status,
      document.uploadedAt, document.updatedAt, document.pageCount, document.error, document.storageName]
  );
  return rowToDocument(rows[0]);
}

// `limit`/`offset` are only passed by the listing route (GET /api/documents) for real pagination.
// Every other caller (citation lookups, report generation, index rebuild) needs the complete set
// to stay correct, so both are opt-in, not a default.
export async function getAllDocuments(limit = null, offset = 0) {
  const { rows } = await getPool().query(
    limit ? 'SELECT * FROM documents ORDER BY uploaded_at DESC LIMIT $1 OFFSET $2' : 'SELECT * FROM documents ORDER BY uploaded_at DESC',
    limit ? [limit, offset] : []
  );
  return rows.map(rowToDocument);
}

export async function getDocumentCounts() {
  const { rows } = await getPool().query(
    `SELECT count(*) AS total, count(*) FILTER (WHERE embedding_status = 'indexed') AS indexed FROM documents`
  );
  return { total: Number(rows[0].total), indexed: Number(rows[0].indexed) };
}

export async function getDocumentById(id) {
  const { rows } = await getPool().query('SELECT * FROM documents WHERE id = $1', [id]);
  return rowToDocument(rows[0]);
}

const PATCH_COLUMNS = {
  name: 'name',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes',
  status: 'status',
  updatedAt: 'updated_at',
  pageCount: 'page_count',
  error: 'error',
  storageName: 'storage_name',
  chunkCount: 'chunk_count',
  embeddingStatus: 'embedding_status'
};

// Applies `patch` as a single atomic UPDATE ... WHERE id = $1. No read-then-write gap exists here,
// so this cannot lose a concurrent writer's change the way the old JSON-file `updateDocument` could.
export async function updateDocument(id, patch) {
  const entries = Object.entries(patch).filter(([key]) => PATCH_COLUMNS[key]);
  if (!entries.length) return getDocumentById(id);

  const setClauses = entries.map(([key], index) => `${PATCH_COLUMNS[key]} = $${index + 2}`);
  const values = entries.map(([, value]) => value);
  const { rows } = await getPool().query(
    `UPDATE documents SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rowToDocument(rows[0]);
}

// Deletes the document row (extractions/chunks cascade via FK) and returns the deleted row
// so the caller can remove the corresponding object-storage blob. Returns null if not found.
export async function deleteDocument(id) {
  const { rows } = await getPool().query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
  return rowToDocument(rows[0]);
}
