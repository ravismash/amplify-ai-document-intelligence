-- Records which document(s) an unscoped question was automatically narrowed to (see
-- resolveAutoScope in server.js), so a saved query is auditable the same way its citations are -
-- NULL means the question stayed genuinely unscoped (no single document dominated) or the user
-- scoped it explicitly themselves.
ALTER TABLE queries ADD COLUMN auto_scoped_document_ids TEXT[];
