# Day 19 Release Readiness

## Repeatable verification

Run the complete local verification from the repository root:

```bash
npm run verify
```

This runs the server integration and negative-path tests, followed by the client production build.

## Integration checklist

- Upload a supported text document and verify metadata.
- Extract text and verify page references.
- Create chunks and embeddings.
- Search indexed evidence and apply document filters.
- Ask a supported question and verify citations.
- Confirm unrelated questions return `no_evidence`.
- Generate and download a Markdown report.
- Delete a document and verify its chunks are no longer accessible.
- Reject unsupported file types and invalid requests.

## Release checks

- Server syntax validation passes.
- Automated positive and negative tests pass.
- Client production build passes.
- Health endpoint reports storage checks.
- Request IDs and structured request logs are emitted.
- Client layout remains responsive at narrow widths.
- No test server or client process remains running after verification.

## Known demo boundary

The demo still uses local filesystem storage and a deterministic local embedding model. These must be replaced with managed production services before deployment outside a controlled demonstration environment.
