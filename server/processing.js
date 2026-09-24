import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createWorker } from 'tesseract.js';
import { randomUUID } from 'node:crypto';
import * as objectStore from './storage/objectStore.js';
import * as chunksDb from './db/chunks.js';

export const OLLAMA_HOST = process.env.OLLAMA_HOST !== undefined ? process.env.OLLAMA_HOST.trim() : 'http://localhost:11434';
export const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL?.trim() || 'nomic-embed-text';

export async function withRetry(operation, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
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
        section: null,
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

export async function extractDocument(storageKey, mimeType) {
  const buffer = await objectStore.getObjectBuffer(storageKey);
  if (mimeType === 'application/pdf') {
    const parsedPdf = await pdfParse(buffer, {
      pagerender: async (pageData) => {
        const textContent = await pageData.getTextContent();
        return textContent.items.map((item) => item.str).join(' ');
      }
    });
    const pages = parsedPdf.text.split('\f').map((text, index) => ({
      pageNumber: index + 1,
      text: text.trim(),
      confidence: null
    })).filter((page) => page.text);
    return { text: parsedPdf.text.trim(), pages: pages.length ? pages : [{ pageNumber: 1, text: parsedPdf.text.trim(), confidence: null }] };
  }

  const text = buffer.toString('utf8').trim();
  return { text, pages: [{ pageNumber: 1, text, confidence: null }] };
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
