-- pgvector's VECTOR(n) enforces an exact dimension per column, so the old 64-dim demo-hash
-- vectors are incompatible with 768-dim nomic-embed-text output and can't migrate in place.
UPDATE chunks
SET embedding = NULL, embedding_model = NULL, embedding_dimensions = NULL,
    embedding_status = 'pending', indexed_at = NULL;

ALTER TABLE chunks ALTER COLUMN embedding TYPE VECTOR(768) USING NULL::VECTOR(768);

UPDATE documents
SET embedding_status = 'pending',
    status = CASE WHEN status = 'ready' THEN 'extracted' ELSE status END
WHERE embedding_status = 'indexed' OR status = 'ready';
