import { getPool } from './pool.js';

function rowToQuery(row) {
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    documentIds: row.document_ids,
    status: row.status,
    answer: row.answer,
    answerModel: row.answer_model,
    evidence: row.evidence,
    citations: row.citations,
    createdAt: row.created_at.toISOString()
  };
}

export async function insertQuery(query) {
  const { rows } = await getPool().query(
    `INSERT INTO queries (id, question, document_ids, status, answer, answer_model, evidence, citations, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [query.id, query.question, query.documentIds, query.status, query.answer, query.answerModel,
      JSON.stringify(query.evidence), JSON.stringify(query.citations), query.createdAt]
  );
  return rowToQuery(rows[0]);
}

export async function getQueryById(id) {
  const { rows } = await getPool().query('SELECT * FROM queries WHERE id = $1', [id]);
  return rowToQuery(rows[0]);
}

export async function getQueriesByIds(ids) {
  const { rows } = await getPool().query('SELECT * FROM queries WHERE id = ANY($1)', [ids]);
  return rows.map(rowToQuery);
}
