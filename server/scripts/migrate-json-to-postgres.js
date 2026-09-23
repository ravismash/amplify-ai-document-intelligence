// One-time migration: server/storage/*.json + server/storage/uploads/* -> Postgres + MinIO.
// Idempotent (safe to re-run) and never deletes the original files.
//
// Usage:
//   node scripts/migrate-json-to-postgres.js              # perform the migration
//   node scripts/migrate-json-to-postgres.js --verify-only # only compare row counts, no writes

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSql } from 'pgvector/pg';
import { getPool, closePool } from '../db/pool.js';
import { stripNulls } from '../db/sanitize.js';
import * as objectStore from '../storage/objectStore.js';

const verifyOnly = process.argv.includes('--verify-only');
const storageDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage');
const uploadsDirectory = path.join(storageDirectory, 'uploads');

const extensionByMimeType = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/plain': '.txt',
  'text/csv': '.csv'
};

function readJson(name) {
  const filePath = path.join(storageDirectory, `${name}.json`);
  if (!fs.existsSync(filePath)) return [];
  return stripNulls(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

async function tablesExist() {
  const { rows } = await getPool().query(
    "SELECT count(*) FROM information_schema.tables WHERE table_name = 'documents'"
  );
  return Number(rows[0].count) > 0;
}

async function migrateDocuments(documents) {
  let migratedFiles = 0;
  let missingFiles = 0;
  for (const doc of documents) {
    let storageName = null;
    if (doc.storageName) {
      const sourcePath = path.join(uploadsDirectory, doc.storageName);
      if (fs.existsSync(sourcePath)) {
        const key = `documents/${doc.id}/original${extensionByMimeType[doc.mimeType] || ''}`;
        if (!(await objectStore.objectExists(key))) {
          const buffer = fs.readFileSync(sourcePath);
          await objectStore.putObject(key, buffer, doc.mimeType);
        }
        storageName = key;
        migratedFiles += 1;
      } else {
        console.warn(`  warning: upload file missing for ${doc.id} (expected ${sourcePath}), storage_name left null`);
        missingFiles += 1;
      }
    }
    await getPool().query(
      `INSERT INTO documents (id, name, mime_type, size_bytes, status, uploaded_at, updated_at, page_count, error, storage_name, chunk_count, embedding_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [doc.id, doc.name, doc.mimeType, doc.sizeBytes, doc.status, doc.uploadedAt, doc.updatedAt,
        doc.pageCount ?? null, doc.error ?? null, storageName, doc.chunkCount ?? null, doc.embeddingStatus ?? null]
    );
  }
  console.log(`  documents: ${documents.length} rows, ${migratedFiles} files uploaded to MinIO, ${missingFiles} missing on disk`);
}

async function migrateExtractions(extractions) {
  for (const extraction of extractions) {
    await getPool().query(
      `INSERT INTO extractions (document_id, status, text, pages, error, extracted_at, method)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (document_id) DO NOTHING`,
      [extraction.documentId, extraction.status, extraction.text ?? null, JSON.stringify(extraction.pages ?? []),
        extraction.error ?? null, extraction.extractedAt ?? null, extraction.method ?? null]
    );
  }
  console.log(`  extractions: ${extractions.length} rows`);
}

async function migrateChunks(chunks) {
  for (const chunk of chunks) {
    await getPool().query(
      `INSERT INTO chunks (id, document_id, text, page_number, section, chunk_index, character_start, character_end,
         embedding_status, embedding, embedding_model, embedding_dimensions, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [chunk.id, chunk.documentId, chunk.text, chunk.pageNumber ?? null, chunk.section ?? null,
        chunk.chunkIndex, chunk.characterStart, chunk.characterEnd, chunk.embeddingStatus,
        Array.isArray(chunk.embedding) ? toSql(chunk.embedding) : null,
        chunk.embeddingModel ?? null, chunk.embeddingDimensions ?? null, chunk.indexedAt ?? null]
    );
  }
  console.log(`  chunks: ${chunks.length} rows`);
}

async function migrateQueries(queries) {
  for (const query of queries) {
    await getPool().query(
      `INSERT INTO queries (id, question, document_ids, status, answer, answer_model, evidence, citations, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [query.id, query.question, query.documentIds ?? null, query.status, query.answer ?? null,
        query.answerModel ?? null, JSON.stringify(query.evidence ?? []), JSON.stringify(query.citations ?? []), query.createdAt]
    );
  }
  console.log(`  queries: ${queries.length} rows`);
}

async function migrateReports(reports) {
  for (const report of reports) {
    await getPool().query(
      `INSERT INTO reports (id, title, document_ids, query_ids, format, status, content, download_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [report.id, report.title, report.documentIds ?? null, report.queryIds ?? null, report.format,
        report.status, report.content, report.downloadUrl ?? null, report.createdAt]
    );
  }
  console.log(`  reports: ${reports.length} rows`);
}

async function verifyCounts(source) {
  const tables = ['documents', 'extractions', 'chunks', 'queries', 'reports'];
  console.log('\nRow count comparison (source JSON vs. Postgres):');
  let allMatch = true;
  for (const table of tables) {
    const { rows } = await getPool().query(`SELECT count(*) FROM ${table}`);
    const pgCount = Number(rows[0].count);
    const sourceCount = source[table].length;
    const match = pgCount >= sourceCount; // >= because ON CONFLICT DO NOTHING may leave pre-existing rows
    allMatch = allMatch && match;
    console.log(`  ${table}: source=${sourceCount} postgres=${pgCount} ${match ? 'OK' : 'MISMATCH'}`);
  }
  return allMatch;
}

async function main() {
  if (!(await tablesExist())) {
    console.error('Postgres schema not found - run `npm run migrate --workspace server` first.');
    process.exitCode = 1;
    return;
  }

  const source = {
    documents: readJson('documents'),
    extractions: readJson('extractions'),
    chunks: readJson('chunks'),
    queries: readJson('queries'),
    reports: readJson('reports')
  };

  if (verifyOnly) {
    const ok = await verifyCounts(source);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log('Migrating server/storage/*.json into Postgres + MinIO (originals are left untouched)...');
  await migrateDocuments(source.documents);
  await migrateExtractions(source.extractions);
  await migrateChunks(source.chunks);
  await migrateQueries(source.queries);
  await migrateReports(source.reports);

  const ok = await verifyCounts(source);
  if (!ok) {
    console.error('\nRow count verification failed - see MISMATCH lines above.');
    process.exitCode = 1;
  } else {
    console.log('\nMigration complete. Original files in server/storage/ were not modified.');
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
