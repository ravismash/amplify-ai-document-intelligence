import { getPool } from './pool.js';

function rowToExtraction(row) {
  if (!row) return null;
  return {
    documentId: row.document_id,
    status: row.status,
    text: row.text,
    pages: row.pages,
    error: row.error,
    extractedAt: row.extracted_at ? row.extracted_at.toISOString() : null,
    ...(row.method ? { method: row.method } : {})
  };
}

// One active extraction per document (matches the old filter-then-unshift JSON behavior),
// enforced here by document_id being the primary key.
export async function upsertExtraction(extraction) {
  const { rows } = await getPool().query(
    `INSERT INTO extractions (document_id, status, text, pages, error, extracted_at, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (document_id) DO UPDATE SET
       status = EXCLUDED.status, text = EXCLUDED.text, pages = EXCLUDED.pages,
       error = EXCLUDED.error, extracted_at = EXCLUDED.extracted_at, method = EXCLUDED.method
     RETURNING *`,
    [extraction.documentId, extraction.status, extraction.text, JSON.stringify(extraction.pages),
      extraction.error, extraction.extractedAt, extraction.method || null]
  );
  return rowToExtraction(rows[0]);
}

export async function getExtractionByDocumentId(documentId) {
  const { rows } = await getPool().query('SELECT * FROM extractions WHERE document_id = $1', [documentId]);
  return rowToExtraction(rows[0]);
}
