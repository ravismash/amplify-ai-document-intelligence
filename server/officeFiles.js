import { inflateRawSync } from 'node:zlib';

// Dependency-free .docx/.xlsx text readers. Office files are zip archives of XML parts; this reads
// the zip's central directory, inflates one part at a time, and scans it in a single forward pass -
// so peak memory stays a small multiple of the largest single part rather than a full object model
// of the document. Libraries were evaluated and rejected on exactly that: mammoth used ~75x the
// extracted text size in memory (600 MB for an 8 MB Word document), and exceljs's streaming reader
// crashed on workbooks whose sheets precede workbook.xml in the archive (including ones exceljs
// itself writes) and silently skipped every sheet after the first on the rest.

export class OfficeFileError extends Error {}

export function readZipDirectory(buffer, { maxUncompressedBytes }) {
  const endOfDirectory = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOfDirectory < 0) throw new OfficeFileError('File is not a valid Office document (zip directory not found)');
  const entryCount = buffer.readUInt16LE(endOfDirectory + 10);
  let offset = buffer.readUInt32LE(endOfDirectory + 16);
  let totalBytes = 0;
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new OfficeFileError('File is not a valid Office document (corrupt zip directory)');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    // Declared sizes are checked before anything is inflated (zip-bomb defence); ZIP64 markers
    // (0xFFFFFFFF) mean "too large to say", which no document within the upload cap needs.
    totalBytes += uncompressedSize === 0xffffffff ? Infinity : uncompressedSize;
    if (totalBytes > maxUncompressedBytes) {
      throw new OfficeFileError(`Document expands beyond the ${Math.round(maxUncompressedBytes / 1048576)} MB uncompressed limit`);
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new OfficeFileError('File is not a valid Office document (corrupt zip entry)');
  }
  const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method !== 8) throw new OfficeFileError(`Unsupported zip compression method ${entry.method}`);
  // maxOutputLength enforces the declared size, so an entry that lies about it can't inflate further.
  return inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressedSize, 1) }).toString('utf8');
}

const xmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return xmlEntities[entity] ?? match;
  });
}

// All <t> runs inside one string item/cell, concatenated (covers plain and rich text).
function textRuns(xml) {
  let text = '';
  for (const match of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += match[1];
  return decodeXml(text);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function columnIndex(cellRef) {
  const letters = (cellRef || '').match(/^[A-Z]+/)?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

// Excel stores dates as serial day numbers; only the cell's number format says it's a date.
// Built-in format IDs 14-22 and 45-47 are date/time formats; custom formats are dates when their
// code uses d/m/y/h tokens outside quoted literals and [colour]/[locale] brackets.
const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyleIndexes(stylesXml) {
  if (!stylesXml) return new Set();
  const customDateFormatIds = new Set();
  for (const [tag] of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const code = (attribute(tag, 'formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/[dmyh]/i.test(code)) customDateFormatIds.add(Number(attribute(tag, 'numFmtId')));
  }
  const cellFormats = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const indexes = new Set();
  [...cellFormats.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], index) => {
    const formatId = Number(attribute(tag, 'numFmtId'));
    if (BUILTIN_DATE_FORMAT_IDS.has(formatId) || customDateFormatIds.has(formatId)) indexes.add(index);
  });
  return indexes;
}

function excelSerialToIsoDate(serial) {
  // 25569 = days from Excel's 1900 epoch (including its fictitious 29 Feb 1900) to 1970-01-01.
  const date = new Date(Math.round((serial - 25569) * 86400000));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

function resolvePartPath(target) {
  const normalized = target.replace(/^\/+/, '');
  return normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
}

function readEntryIfPresent(buffer, entries, name) {
  const entry = entries.get(name);
  return entry ? readZipEntry(buffer, entry) : null;
}

// Yields { name, rows } per worksheet in workbook order; rows are arrays of cell strings.
export function* readWorkbookSheets(buffer, { maxUncompressedBytes }) {
  const entries = readZipDirectory(buffer, { maxUncompressedBytes });
  const workbookXml = readEntryIfPresent(buffer, entries, 'xl/workbook.xml');
  if (!workbookXml) throw new OfficeFileError('File is not a valid Excel workbook (xl/workbook.xml missing)');

  const relsXml = readEntryIfPresent(buffer, entries, 'xl/_rels/workbook.xml.rels') || '';
  const targetsById = new Map();
  for (const [tag] of relsXml.matchAll(/<Relationship\b[^>]*>/g)) targetsById.set(attribute(tag, 'Id'), attribute(tag, 'Target'));

  const sharedStringsXml = readEntryIfPresent(buffer, entries, 'xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1])) : [];

  const dateStyles = dateStyleIndexes(readEntryIfPresent(buffer, entries, 'xl/styles.xml'));

  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({
    name: attribute(tag, 'name'),
    path: resolvePartPath(targetsById.get(attribute(tag, 'r:id')) || '')
  }));

  for (const sheet of sheets) {
    const sheetXml = readEntryIfPresent(buffer, entries, sheet.path);
    if (!sheetXml) continue;
    const rows = [];
    for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, attributes, inner = ''] = cellMatch;
        const type = attribute(attributes, 't');
        const position = columnIndex(attribute(attributes, 'r')) ?? cells.length;
        const rawValue = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (type === 's') value = sharedStrings[Number(rawValue)] ?? '';
        else if (type === 'inlineStr') value = textRuns(inner);
        else if (type === 'b') value = rawValue === '1' ? 'TRUE' : 'FALSE';
        else if (rawValue !== undefined && !type && dateStyles.has(Number(attribute(attributes, 's'))) && Number.isFinite(Number(rawValue))) value = excelSerialToIsoDate(Number(rawValue));
        else if (rawValue !== undefined) value = decodeXml(rawValue);
        cells[position] = value;
      }
      rows.push(Array.from(cells, (cell) => cell ?? ''));
    }
    yield { name: sheet.name, rows };
  }
}

// Paragraph text of the main document body, in order. Tables are included (their cells are
// paragraphs too); tabs and line breaks are kept so columns and addresses don't run together.
export function readDocxText(buffer, { maxUncompressedBytes }) {
  const entries = readZipDirectory(buffer, { maxUncompressedBytes });
  const documentXml = readEntryIfPresent(buffer, entries, 'word/document.xml');
  if (!documentXml) throw new OfficeFileError('File is not a valid Word document (word/document.xml missing)');
  const paragraphs = [];
  for (const paragraphMatch of documentXml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    let text = '';
    for (const token of (paragraphMatch[1] || '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
      if (token[1] !== undefined) text += decodeXml(token[1]);
      else text += token[2] === 'tab' ? '\t' : '\n';
    }
    paragraphs.push(text);
  }
  return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
