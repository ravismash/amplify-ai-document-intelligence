import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createWorker } from 'tesseract.js';
import { randomUUID } from 'node:crypto';
import * as objectStore from './storage/objectStore.js';
import * as chunksDb from './db/chunks.js';
import { readDocxText, readWorkbookSheets } from './officeFiles.js';

export const OLLAMA_HOST = process.env.OLLAMA_HOST !== undefined ? process.env.OLLAMA_HOST.trim() : 'http://localhost:11434';
export const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL?.trim() || 'nomic-embed-text';

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
  const worker = await createWorker('eng');
  try {
    const buffer = await objectStore.getObjectBuffer(storageKey);
    const result = await worker.recognize(buffer);
    const text = result.data.text.trim();
    return {
      text,
      pages: [{
        pageNumber: 1,
        text,
        confidence: Math.round(result.data.confidence)
      }]
    };
  } finally {
    await worker.terminate();
  }
}
