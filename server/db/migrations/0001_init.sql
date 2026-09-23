CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  status           TEXT NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_count       INTEGER,
  error            TEXT,
  storage_name     TEXT,
  chunk_count      INTEGER,
  embedding_status TEXT
);

CREATE TABLE extractions (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  text         TEXT,
  pages        JSONB NOT NULL DEFAULT '[]',
  error        TEXT,
  extracted_at TIMESTAMPTZ,
  method       TEXT
);

CREATE TABLE chunks (
  id                   TEXT PRIMARY KEY,
  document_id          TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text                 TEXT NOT NULL,
  page_number          INTEGER,
  section              TEXT,
  chunk_index          INTEGER NOT NULL,
  character_start      INTEGER NOT NULL,
  character_end        INTEGER NOT NULL,
  embedding_status     TEXT NOT NULL DEFAULT 'pending',
  embedding            VECTOR(64),
  embedding_model      TEXT,
  embedding_dimensions INTEGER,
  indexed_at           TIMESTAMPTZ
);
CREATE INDEX chunks_document_id_idx ON chunks(document_id);

CREATE TABLE queries (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  document_ids TEXT[],
  status       TEXT NOT NULL,
  answer       TEXT,
  answer_model TEXT,
  evidence     JSONB NOT NULL DEFAULT '[]',
  citations    JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX queries_created_at_idx ON queries(created_at DESC);

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  document_ids TEXT[],
  query_ids    TEXT[],
  format       TEXT NOT NULL DEFAULT 'markdown',
  status       TEXT NOT NULL DEFAULT 'completed',
  content      TEXT NOT NULL,
  download_url TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_created_at_idx ON reports(created_at DESC);
