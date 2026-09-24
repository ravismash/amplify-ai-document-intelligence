import { getPool } from './pool.js';

function rowToReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    documentIds: row.document_ids,
    queryIds: row.query_ids,
    format: row.format,
    status: row.status,
    content: row.content,
    downloadUrl: row.download_url,
    createdAt: row.created_at.toISOString()
  };
}

export async function insertReport(report) {
  const { rows } = await getPool().query(
    `INSERT INTO reports (id, title, document_ids, query_ids, format, status, content, download_url, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [report.id, report.title, report.documentIds, report.queryIds, report.format,
      report.status, report.content, report.downloadUrl, report.createdAt]
  );
  return rowToReport(rows[0]);
}

export async function getAllReports(limit = null, offset = 0) {
  const { rows } = await getPool().query(
    limit ? 'SELECT * FROM reports ORDER BY created_at DESC LIMIT $1 OFFSET $2' : 'SELECT * FROM reports ORDER BY created_at DESC',
    limit ? [limit, offset] : []
  );
  return rows.map(rowToReport);
}

export async function countReports() {
  const { rows } = await getPool().query('SELECT count(*) FROM reports');
  return Number(rows[0].count);
}

export async function getReportById(id) {
  const { rows } = await getPool().query('SELECT * FROM reports WHERE id = $1', [id]);
  return rowToReport(rows[0]);
}
