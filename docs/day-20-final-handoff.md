# Day 20 Final Handoff

## Demo workflow

1. Start the project with `npm run dev`.
2. Open `http://localhost:5173`.
3. Upload a supported text, PDF, CSV, PNG, or JPEG document.
4. Extract text, or run OCR for an image scan.
5. Index embeddings for the extracted document.
6. Search indexed evidence from the dashboard.
7. Ask a question and expand its citations.
8. Generate and download a Markdown report.
9. Use the document filters to review processing state.

## Acceptance checklist

- [x] Client and server are separated into workspaces.
- [x] Upload validation and metadata persistence work.
- [x] Text extraction and OCR work with page references.
- [x] Chunks and embeddings are generated and searchable.
- [x] Questions return evidence or an explicit no-evidence state.
- [x] Citations show document, page, chunk, excerpt, and score.
- [x] Reports can be generated, listed, and downloaded.
- [x] API-key protection, CORS, request IDs, and security headers are available.
- [x] Automated positive and negative tests pass.
- [x] Client production build passes.
- [x] Full verification passes with `npm run verify`.

## Final verification

```bash
npm run verify
```

## Demo boundary

This 20-day deliverable is ready for controlled demonstration and stakeholder review. Before production deployment, replace local JSON/filesystem storage and the local demo embedding model with managed database, object storage, queue, vector, and AI provider services. Complete authentication, authorization, secrets management, backups, monitoring, load testing, and security review in the production hardening phase.
