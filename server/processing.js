import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { randomUUID } from 'node:crypto';
import * as objectStore from './storage/objectStore.js';
import * as chunksDb from './db/chunks.js';
import { readDocxText, readWorkbookSheets } from './officeFiles.js';

export const OLLAMA_HOST = process.env.OLLAMA_HOST !== undefined ? process.env.OLLAMA_HOST.trim() : 'http://localhost:11434';
export const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL?.trim() || 'nomic-embed-text';
// Self-hosted PaddleOCR service (see ocr_service/) - replaces Tesseract, which scored 49%
// confidence with visible garbled characters on this app's own real invoice scan, against
// PaddleOCR's 99% with clean text on the same file (measured directly, not a vendor benchmark).
// Also closes a real privacy gap Tesseract had: it fetches its language data from a public CDN on
// first use, which PaddleOCR's model-source check (disabled in ocr_service/app.py) does not.
export const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL !== undefined ? process.env.OCR_SERVICE_URL.trim() : 'http://localhost:8100';

export async function withRetry(operation, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  throw lastError;
}

export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Detects document structure (chapters, numbered sections) so questions like "how many chapters"
// or "what does chapter 3 say" can be answered by direct lookup instead of chunk-similarity search
// - which can't answer positional/aggregate questions about a document's own structure (see
// eval/questions.json history: the correct chapter heading can rank far outside any retrieval
// window because "chapter one" doesn't share much topical content with a bare heading).
// Two conventions covered: "1. Section title" on its own line (common in contracts/policies -
// e.g. this app's own Procurement Policy fixture), and "CHAPTER N" / "Chapter N" (books). A
// document with neither convention simply has no detected sections - that's a fact about the
// document, not a gap in detection.
// Real sections in a short document (e.g. this app's own Procurement Policy fixture) can be as
// close as ~160 chars apart - 100 stays safely below that while still rejecting near-zero-length
// degenerate matches. (Originally 300, tuned against table-of-contents noise; that noise turned
// out to come entirely from the case-insensitivity bug fixed above, not from short real sections -
// a PDF page has no internal line breaks at all, so the numbered-section pattern, which requires
// one, can never match a PDF's table of contents in the first place.)
const MIN_SECTION_CHARS = 100;
const SECTION_PATTERNS = [
  { regex: /^[ \t]*(\d{1,2})\.[ \t]+([A-Z][^\n]{2,80})[ \t]*$/gm, title: (m) => `${m[1]}. ${m[2].trim()}` },
  // Case-sensitive, ALL-CAPS only: real headings are typeset as "CHAPTER 1", while an in-text
  // cross-reference like "(see Chapter 9)" uses normal case - matching case-insensitively pulled
  // in every prose mention of a chapter number as a false heading. Negative lookbehind excludes
  // "COMMENTARY ON CHAPTER N" (a distinct, later section in some books) from being misread as the
  // start of "CHAPTER N" itself.
  { regex: /(?<!COMMENTARY ON )\bCHAPTER[ \t]+([0-9]+|[IVXLCM]+)\b/g, title: (m) => `Chapter ${m[1]}` },
  // Numbered ALL-CAPS headings with no line break before/after them at all, e.g. "1. SCOPE
  // Supplier provides..." - the common case for a PDF, where a whole page's text is one
  // space-joined run with no layout information (see extractPdf), so the line-anchored pattern
  // above can never match. The lookahead for a Title-Case word or another number marks where the
  // caps heading ends and body text (or the next item) begins.
  { regex: /\b(\d{1,2})\.[ \t]+([A-Z][A-Z \t]{2,40}?)(?=[ \t][A-Z][a-z]|[ \t]\d)/g, title: (m) => `${m[1]}. ${m[2].trim()}` }
];

// The exact concatenation detectSectionMarkers' offsets are computed against (each page
// normalized, joined with no separator) - callers that need to slice out a section's raw text by
// marker offset must build the same string, not re-derive it differently.
export function concatenatePages(pages) {
  return pages.map((page) => normalizeText(page.text || '')).join('');
}

export function detectSectionMarkers(pages) {
  const normalizedPages = pages.map((page) => ({ pageNumber: page.pageNumber, text: normalizeText(page.text || '') })).filter((page) => page.text);

  // Patterns are tried in priority order and the first one that finds anything for this document
  // wins outright - only that pattern's markers are used, the rest are not even tried. Mixing
  // patterns for the same document invites exactly the collision found in testing: a looser
  // pattern (needed for PDFs with no line breaks at all) can match a page-range citation like
  // "pp. 49-52. FIGURE 20-1" as if it were a real heading, which a stricter pattern (like this
  // book's reliable "CHAPTER N") would never have produced in the first place.
  let markers = [];
  for (const pattern of SECTION_PATTERNS) {
    let globalOffset = 0;
    const patternMarkers = [];
    for (const page of normalizedPages) {
      for (const match of page.text.matchAll(pattern.regex)) {
        patternMarkers.push({ globalOffset: globalOffset + match.index, pageNumber: page.pageNumber, charOffset: match.index, title: pattern.title(match) });
      }
      globalOffset += page.text.length;
    }
    if (patternMarkers.length) {
      markers = patternMarkers;
      break;
    }
  }
  const globalOffset = normalizedPages.reduce((sum, page) => sum + page.text.length, 0);
  markers.sort((left, right) => left.globalOffset - right.globalOffset);
  // Drop markers that don't span meaningful content before the next one - filters out dense
  // listings (a table of contents matches these same patterns once per entry) while keeping real
  // sections, which span far more than a table-of-contents line.
  return markers.filter((marker, index) => {
    const next = markers[index + 1];
    const length = (next ? next.globalOffset : globalOffset) - marker.globalOffset;
    return length >= MIN_SECTION_CHARS;
  });
}

export function createChunks(documentId, pages) {
  const chunkSize = 900;
  const overlap = 120;
  const chunks = [];

  for (const page of pages) {
    const text = normalizeText(page.text);
    if (!text) continue;
    let start = 0;
    let chunkIndex = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunkText = text.slice(start, end).trim();
      chunks.push({
        id: `chunk_${randomUUID()}`,
        documentId,
        text: chunkText,
        pageNumber: page.pageNumber,
        section: page.section || null,
        chunkIndex,
        characterStart: start,
        characterEnd: end,
        embeddingStatus: 'pending'
      });
      if (end === text.length) break;
      start = Math.max(end - overlap, start + 1);
      chunkIndex += 1;
    }
  }
  return chunks;
}

export async function persistChunks(documentId, pages) {
  const documentChunks = createChunks(documentId, pages);
  await chunksDb.replaceChunksForDocument(documentId, documentChunks);
  return documentChunks;
}

export async function callOllamaEmbeddingBatch(texts) {
  const response = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: texts })
  });
  if (!response.ok) throw new Error(`Ollama embedding request failed: ${response.status}`);
  const data = await response.json();
  return data.embeddings;
}

// nomic-embed-text is trained on prefixed inputs and produces poorly separated similarity scores
// without them - documents and queries use different prefixes because the model is asymmetric
// (a query and its matching passage aren't expected to look alike, unlike a passage vs itself).
export async function embedTexts(texts, taskPrefix, batchSize = 16) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((text) => `${taskPrefix}${text}`);
    vectors.push(...(await withRetry(() => callOllamaEmbeddingBatch(batch))));
  }
  return vectors;
}

export async function indexDocumentChunks(documentId) {
  const documentChunks = await chunksDb.getChunksByDocumentId(documentId);
  if (!documentChunks.length) return [];
  const embeddings = await embedTexts(documentChunks.map((chunk) => chunk.text), 'search_document: ');
  const indexedAt = new Date().toISOString();
  const indexedChunks = documentChunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index],
    embeddingModel: OLLAMA_EMBEDDING_MODEL,
    embeddingDimensions: embeddings[index].length,
    embeddingStatus: 'indexed',
    indexedAt
  }));
  await chunksDb.setChunkEmbeddings(indexedChunks);
  return indexedChunks;
}

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Bounds on what a single upload may expand into. The 25 MB upload cap limits bytes on the wire,
// but a .docx/.xlsx is a zip archive that can inflate to gigabytes (a "zip bomb"), and every
// extracted character eventually costs embedding time - so both are capped before and during
// parsing rather than discovered as an out-of-memory crash in the worker.
const MAX_UNCOMPRESSED_BYTES = Number(process.env.MAX_UNCOMPRESSED_BYTES) || 250 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = Number(process.env.MAX_EXTRACTED_CHARS) || 20_000_000;

function textLimitError() {
  return new Error(`Document text exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} character extraction limit`);
}

async function extractPdf(buffer) {
  // pdf-parse renders pages in order and joins them with blank lines, which can't be split back
  // apart reliably - so each page's text is captured here as it's rendered instead.
  const pageTexts = [];
  let totalChars = 0;
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent();
      const text = textContent.items.map((item) => item.str).join(' ');
      totalChars += text.length;
      if (totalChars > MAX_EXTRACTED_CHARS) throw textLimitError();
      pageTexts[pageData.pageIndex] = text;
      return text;
    }
  });
  const pages = pageTexts
    .map((text, index) => ({ pageNumber: index + 1, text: (text || '').trim(), confidence: null }))
    .filter((page) => page.text);
  return { text: pages.map((page) => page.text).join('\n\n'), pages, pageCount: pageTexts.length };
}

function extractDocx(buffer) {
  const text = readDocxText(buffer, { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES });
  if (text.length > MAX_EXTRACTED_CHARS) throw textLimitError();
  // Word documents have no fixed pagination (it depends on the renderer), so the whole body is one page.
  return { text, pages: text ? [{ pageNumber: 1, text, confidence: null }] : [], pageCount: 1 };
}

function extractXlsx(buffer) {
  // Each sheet becomes a "page" so citations can name the sheet, and sheets are read one at a time.
  const pages = [];
  let totalChars = 0;
  let sheetNumber = 0;
  for (const sheet of readWorkbookSheets(buffer, { maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES })) {
    sheetNumber += 1;
    const lines = [];
    let headers = null;
    for (const cells of sheet.rows) {
      if (!cells.some((cell) => cell.trim())) continue;
      // A first row of plain labels is treated as a header, and later rows are written as
      // "Header: value" pairs - so a chunk from the middle of a long sheet still says what each
      // number means, which is what retrieval needs to match a question to a row.
      if (!headers && !lines.length && cells.every((cell) => cell.trim() && Number.isNaN(Number(cell)))) {
        headers = cells;
        lines.push(cells.join(', '));
      } else {
        lines.push(cells
          .map((cell, index) => (cell.trim() && headers?.[index] ? `${headers[index]}: ${cell}` : cell))
          .filter((cell) => cell.trim())
          .join(', '));
      }
      totalChars += lines[lines.length - 1].length + 1;
      if (totalChars > MAX_EXTRACTED_CHARS) throw textLimitError();
    }
    const name = sheet.name || `Sheet${sheetNumber}`;
    if (lines.length) pages.push({ pageNumber: sheetNumber, section: name, text: `Sheet: ${name}\n${lines.join('\n')}`, confidence: null });
  }
  return { text: pages.map((page) => page.text).join('\n\n'), pages, pageCount: sheetNumber };
}

function extractPlainText(buffer) {
  const text = buffer.toString('utf8').replace(/\0/g, '').trim();
  if (text.length > MAX_EXTRACTED_CHARS) throw textLimitError();
  return { text, pages: [{ pageNumber: 1, text, confidence: null }], pageCount: 1 };
}

const extractorsByMimeType = {
  'application/pdf': extractPdf,
  [DOCX_MIME_TYPE]: extractDocx,
  [XLSX_MIME_TYPE]: extractXlsx
};

export async function extractDocument(storageKey, mimeType) {
  const buffer = await objectStore.getObjectBuffer(storageKey);
  try {
    return await (extractorsByMimeType[mimeType] || extractPlainText)(buffer);
  } catch (error) {
    // A file that fails to parse (corrupt, over a limit) will fail identically on every retry -
    // unlike the object-store read above - so it's marked permanent and not retried.
    error.permanent = true;
    throw error;
  }
}

export async function ocrDocument(storageKey) {
  const buffer = await objectStore.getObjectBuffer(storageKey);
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'image');
  const response = await fetch(`${OCR_SERVICE_URL}/ocr`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`OCR service request failed: ${response.status}`);
  const { text, confidence } = await response.json();
  return {
    text,
    pages: [{
      pageNumber: 1,
      text,
      confidence
    }]
  };
}
