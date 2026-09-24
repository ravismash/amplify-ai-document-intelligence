# Amplify AI Document Intelligence

This project is the starting point for the AI consultancy PoC described in the project brief.

## Day 1 goal

Set up the working project skeleton and a professional UI shell so the team can begin building the core document intelligence workflow.

## Deliverables for Day 1

- Frontend app shell with dashboard layout
- Backend API with health endpoint
- Clear separation between client and server
- Local development setup
- Foundation for future document upload, retrieval, and reporting features

## Stack

- Frontend: React + Vite
- Backend: Node + Express
- Local development: workspace scripts

## Local run

Requires [Docker](https://www.docker.com/) for Postgres (with pgvector) and MinIO, and [Ollama](https://ollama.com/) running locally with `nomic-embed-text` pulled (`ollama pull nomic-embed-text`) - chunk/query embeddings call it directly, so `npm test` needs a real Ollama available, not just a mock.

```bash
npm install
npm run docker:up      # starts Postgres + MinIO
npm run migrate --workspace server
cp server/.env.example server/.env   # fill in JWT_SECRET (required - generate with `openssl rand -hex 32`) and ANTHROPIC_API_KEY if not using local Ollama
npm run create-user --workspace server -- <username> <password>   # one-time, provisions your login
npm run dev
npm test --workspace server
```

There is no signup UI - this app uses a single shared login, not per-user accounts, so access is provisioned via the `create-user` script above.

Every push and pull request runs the same verification automatically through [CI](.github/workflows/ci.yml), including tests, the production build, syntax checks, and a high-severity dependency audit.

Then open:

- Frontend: http://localhost:5173
- Backend: http://localhost:4000/api/health

## Observability

The server exposes Prometheus-format metrics at `/metrics` (HTTP request rate/latency, job queue depth, default Node.js process metrics) and a `GET /api/health` endpoint whose `status` field genuinely reflects the health of Postgres, object storage, and Redis (not a hardcoded `ok`).

`/metrics` is intentionally unauthenticated, matching standard Prometheus exporter convention - it must not be exposed on the public internet in a real deployment; restrict it at the firewall/reverse-proxy level to only the box running Prometheus.

A self-hosted Prometheus + Grafana stack is available behind a Docker Compose profile, off by default so everyday `npm run docker:up` stays fast:

```bash
npm run observability:up
```

Then open Grafana at http://localhost:3000 (default login `admin`/`admin`, or set `GRAFANA_ADMIN_PASSWORD`) - the Prometheus datasource and the "Amplify AI Overview" dashboard are both auto-provisioned from files in `observability/`, no manual setup required.

## Security

- **Rate limiting** (Redis-backed, per IP, survives restarts): login is capped at 10 attempts/15 min (brute-force protection); `/api/questions`, `/api/search`, and `/api/search/evaluate` at 60/15 min (LLM/embedding cost abuse); document upload at 30/15 min; `/api/index/rebuild` at 5/15 min. All configurable via env vars (see `server/.env.example`). Plain reads and the already-queued single-document extract/OCR/index routes are deliberately left unlimited - they're cheap and already guarded by Phase 4's double-submission check and bounded queue concurrency.
- **Input caps**: `documentIds`/`queryIds` arrays are capped at 100 entries, questions/queries at 2000 characters, and `/api/search/evaluate`'s `cases` array at 20 entries. `GET /api/documents` and `GET /api/reports` are capped at 500 rows as a defensive backstop against unbounded growth (not full pagination - a future improvement if the corpus grows past that).
- **Headers**: `helmet` sets CSP, HSTS, and the standard hardening headers on every response.
- **Dependency scanning**: CI runs `npm audit --audit-level=high` across the full dependency tree (including devDependencies, closing a gap where client build-tooling vulnerabilities were previously invisible to the gate) and `gitleaks` on every push/PR for secret scanning. A full-history scan (`gitleaks detect --source .`) was also run manually and found nothing.

## 20-Day Delivery Plan

### Day 1 - Project foundation (complete)

- Set up the React/Vite client and Node/Express server
- Create the dashboard application shell
- Add the backend health endpoint
- Establish separate client and server workspaces
- Verify the local development workflow

### Day 2 - Requirements and data model (complete)

- Define document, extraction, chunk, query, citation, and report data shapes
- Identify supported file types and size limits
- Document the first end-to-end user workflow

See [Day 2 requirements and data model](docs/day-2-requirements.md) for the detailed contracts and acceptance criteria.

### Day 3 - Document upload experience (complete)

- Add drag-and-drop and file picker upload controls
- Show upload progress, success, and failure states
- Validate file type and file size on the client

### Day 4 - Upload API and metadata storage (complete)

- Implement the document upload API
- Store document metadata and processing status
- Add document list and detail endpoints

### Day 5 - Text extraction (complete)

- Extract text from supported text and PDF files
- Persist extraction results and processing errors
- Add an extraction status to the document workflow

### Day 6 - OCR support (complete)

- Add OCR processing for scanned documents
- Normalize OCR output and retain page references
- Surface OCR confidence and failures where available

### Day 7 - Text preparation (complete)

- Clean and normalize extracted text
- Split documents into traceable chunks
- Preserve document, page, and section metadata for citations

### Day 8 - Embedding pipeline (complete)

- Select and configure the embedding provider
- Generate embeddings for document chunks
- Track embedding status and retryable failures

### Day 9 - Retrieval index (complete)

- Add a vector index for document chunks
- Index new and updated documents
- Support deletion and re-indexing of document content

### Day 10 - Retrieval quality (complete)


See [Day 10 retrieval quality](docs/day-10-retrieval-quality.md) for the evaluation contract and metrics.

- Add request validation and response status handling
### Day 11 - Question answering API (complete)
- Prevent answers from using unrelated document content

### Day 12 - Citations and evidence (complete)

- Attach document and page citations to every answer
- Return supporting excerpts with stable references
- Handle questions with insufficient evidence explicitly

### Day 13 - Question answering interface (complete)

- Add the question and answer workflow to the client
- Display loading, empty, error, and no-evidence states
- Make citations open the relevant document context

### Day 14 - Report generation (complete)

- Define report sections and output formats
- Generate reports from documents, answers, and citations
- Add report status and download behavior

### Day 15 - Dashboard workflow (complete)

- Connect document, processing, query, and report views
- Add search, filtering, and sorting for documents
- Show processing and reporting progress at a glance

### Day 16 - Security and access controls (complete)

- Validate all API inputs and uploaded content
- Protect secrets and environment-specific configuration
- Add basic access boundaries for documents and reports

### Day 17 - Reliability and observability (complete)

- Add structured server logging and request correlation
- Add retries for transient processing failures
- Provide actionable error messages and recovery actions

### Day 18 - Automated testing (complete)

- Add unit tests for parsing, chunking, retrieval, and citations
- Add API tests for upload, processing, querying, and reports
- Add client tests for the primary document workflow

### Day 19 - Integration and release readiness (complete)

- Run the complete end-to-end workflow with representative documents
- Test large files, OCR failures, empty results, and service errors
- Review performance, accessibility, and responsive behavior

See [Day 19 release readiness](docs/day-19-release-readiness.md) for the verification checklist.

### Day 20 - Final polish and handoff (complete)

- Fix release-blocking issues and refine the dashboard experience
- Update setup, API, and workflow documentation
- Prepare a demo dataset and acceptance checklist
- Verify the final build and handoff the project

See [Day 20 final handoff](docs/day-20-final-handoff.md) for the demo runbook, acceptance checklist, and production boundary.
