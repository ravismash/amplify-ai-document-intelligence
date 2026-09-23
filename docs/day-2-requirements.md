# Day 2 Requirements and Data Model

## Product scope

The first release supports a user who uploads business documents, waits for processing, asks questions over the available documents, reviews evidence, and generates a report.

The initial workflow is:

1. Select one or more supported documents.
2. Validate file type and size before upload.
3. Store document metadata and mark the document as `uploaded`.
4. Extract text and record processing progress.
5. Split extracted text into traceable chunks and index them.
6. Ask a question against the selected document set.
7. Return an answer with supporting citations or an explicit no-evidence result.
8. Generate and download a report containing the answer, citations, and document metadata.

## Supported documents

| Format | MIME type | Maximum size |
| --- | --- | ---: |
| PDF | `application/pdf` | 25 MB |
| Microsoft Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | 25 MB |
| Microsoft Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 25 MB |
| PNG or JPEG scan | `image/png` or `image/jpeg` | 25 MB |
| Plain text | `text/plain` | 10 MB |
| CSV | `text/csv` | 10 MB |

The client and server must enforce the same limits. Unsupported formats and files over the limit must be rejected before processing.

## Data contracts

### Document

```json
{
  "id": "doc_01J...",
  "name": "project-brief.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 1048576,
  "status": "uploaded",
  "uploadedAt": "2026-09-21T10:00:00.000Z",
  "updatedAt": "2026-09-21T10:00:00.000Z",
  "pageCount": null,
  "error": null
}
```

Document status values are: `uploaded`, `extracting`, `extracted`, `indexing`, `ready`, and `failed`.

### Extraction

```json
{
  "documentId": "doc_01J...",
  "status": "completed",
  "text": "Extracted document text...",
  "pages": [
    {
      "pageNumber": 1,
      "text": "Text from page one...",
      "confidence": null
    }
  ],
  "error": null
}
```

Extraction status values are: `pending`, `processing`, `completed`, and `failed`.

### Chunk

```json
{
  "id": "chunk_01J...",
  "documentId": "doc_01J...",
  "text": "A traceable section of extracted text...",
  "pageNumber": 1,
  "section": null,
  "chunkIndex": 0,
  "embeddingStatus": "pending"
}
```

Embedding status values are: `pending`, `indexed`, and `failed`.

### Query and answer

```json
{
  "id": "query_01J...",
  "question": "What are the major project risks?",
  "documentIds": ["doc_01J..."],
  "answer": "The major risks are schedule delay and supplier dependency.",
  "citations": [
    {
      "documentId": "doc_01J...",
      "documentName": "project-brief.pdf",
      "pageNumber": 3,
      "chunkId": "chunk_01J...",
      "excerpt": "The project risk register identifies..."
    }
  ],
  "status": "completed",
  "createdAt": "2026-09-21T10:05:00.000Z"
}
```

Query status values are: `pending`, `retrieving`, `answering`, `completed`, `no_evidence`, and `failed`.

### Report

```json
{
  "id": "report_01J...",
  "title": "Project risk review",
  "documentIds": ["doc_01J..."],
  "queryIds": ["query_01J..."],
  "format": "pdf",
  "status": "completed",
  "downloadUrl": "/api/reports/report_01J.../download",
  "createdAt": "2026-09-21T10:10:00.000Z"
}
```

Report status values are: `pending`, `generating`, `completed`, and `failed`.

## Acceptance criteria

- The same supported-format and size rules are documented for client and server implementation.
- Each processing stage has an explicit status and failure state.
- Extracted text remains traceable to a document and page where available.
- Answers can return citations, or clearly report that evidence was insufficient.
- Reports reference the source documents and questions used to create them.
- Day 3 can implement upload UI and validation directly from this contract.
