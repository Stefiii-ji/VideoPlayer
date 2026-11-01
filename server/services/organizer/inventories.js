import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { resolvePathWithinRoot } from '../path-safety.js';

export const INVENTORY_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxSheets: 8,
  maxZipEntries: 512,
  maxExpandedBytes: 50 * 1024 * 1024,
  maxExpandedEntryBytes: 16 * 1024 * 1024,
});

const KNOWN_WORKSHEETS = new Set(['read me', '341 file plan', 'folder plan', 'virtual collections']);

function normalizedHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') text = String(value).trim();
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object' && typeof value.text === 'string') text = value.text.trim();
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    text = value.richText.map((item) => item.text ?? '').join('').trim();
  }
  if (text === undefined) return '';
  if (text.length > 2048) {
    throw Object.assign(new Error('Inventory contains a cell that exceeds the text limit.'), { status: 400 });
  }
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      if (rows.length > INVENTORY_LIMITS.maxRows + 1) {
        throw Object.assign(new Error(`Inventory exceeds the ${INVENTORY_LIMITS.maxRows} row limit.`), { status: 413 });
      }
    } else {
      field += character;
    }
  }
  if (quoted) throw Object.assign(new Error('CSV inventory contains an unterminated quoted field.'), { status: 400 });
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (rows.length > INVENTORY_LIMITS.maxRows + 1) {
    throw Object.assign(new Error(`Inventory exceeds the ${INVENTORY_LIMITS.maxRows} row limit.`), { status: 413 });
  }
  return rows;
}

function headerMap(values) {
  const columns = new Map();
  values.forEach((value, index) => {
    const header = normalizedHeader(value);
    if (header) columns.set(header, index);
  });
  return columns;
}

function findColumn(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return columns.get(candidate);
  }
  return -1;
}

function mapHeaders(columns) {
  return {
    name: findColumn(columns, ['name', 'filename', 'foldername', 'title', 'moviename']),
    relativePath: findColumn(columns, ['relativepath', 'path', 'filepath', 'sourcepath', 'folderpath']),
    extension: findColumn(columns, ['extension', 'ext']),
    size: findColumn(columns, ['size', 'sizegb', 'sizemb']),
    modified: findColumn(columns, ['modified', 'modifieddate', 'lastmodified']),
    parentFolder: findColumn(columns, ['parentfolder']),
  };
}

function recordFromRow(values, indexes, worksheetName = null) {
  const get = (index) => index >= 0 ? cellValue(values[index]) : '';
  let relativePath = get(indexes.relativePath);
  const rawName = get(indexes.name);
  const name = rawName ? path.posix.basename(path.win32.basename(rawName)) : '';
  let extension = get(indexes.extension);
  if (extension && !/^\.[a-z0-9]{1,10}$/i.test(extension)) extension = '';
  let size = get(indexes.size);
  if (size && !/^\d+(?:\.\d+)?$/.test(size)) size = '';
  let modified = get(indexes.modified);
  if (modified) {
    const timestamp = Date.parse(modified);
    modified = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  }
  if (!relativePath && name && indexes.relativePath < 0) relativePath = '';
  return {
    name: name || null,
    relativePath: relativePath || null,
    extension: extension || null,
    size: size || null,
    modified: modified || null,
    parentFolder: get(indexes.parentFolder) || null,
    worksheet: worksheetName,
  };
}

function parseCsvBuffer(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw Object.assign(new Error('CSV inventory must use valid UTF-8 encoding.'), { status: 400 });
  }
  const rows = parseCsv(text);
  if (!rows.length) throw Object.assign(new Error('CSV inventory is empty.'), { status: 400 });
  const indexes = mapHeaders(headerMap(rows[0]));
  if (indexes.relativePath < 0) {
    throw Object.assign(new Error('CSV inventory must include a RelativePath column.'), { status: 400 });
  }
  if (rows.slice(1).some((row) => row.length !== rows[0].length)) {
    throw Object.assign(new Error('CSV inventory contains a row with an inconsistent number of columns.'), { status: 400 });
  }
  return {
    records: rows.slice(1).map((row) => recordFromRow(row, indexes)).filter((record) =>
      record.relativePath || record.name || record.parentFolder),
    ignoredWorksheets: [],
  };
}

function validateXlsxArchive(buffer) {
  const searchStart = Math.max(0, buffer.length - 65557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > buffer.length) {
    throw Object.assign(new Error('XLSX inventory is malformed or cannot be read.'), { status: 400 });
  }
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || totalEntries > INVENTORY_LIMITS.maxZipEntries
    || endOffset + 22 + commentLength !== buffer.length
    || centralOffset + centralSize > endOffset) {
    throw Object.assign(new Error('XLSX inventory has an unsupported or malformed ZIP structure.'), { status: 400 });
  }

  let cursor = centralOffset;
  let expandedBytes = 0;
  const entryNames = new Set();
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw Object.assign(new Error('XLSX inventory has an invalid ZIP directory.'), { status: 400 });
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expandedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > centralOffset + centralSize || (flags & 1) !== 0
      || compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff
      || expandedSize > INVENTORY_LIMITS.maxExpandedEntryBytes
      || localOffset >= centralOffset) {
      throw Object.assign(new Error('XLSX inventory contains an unsupported ZIP entry.'), { status: 400 });
    }
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const segments = name.split(/[\\/]+/);
    if (name.startsWith('/') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || segments.some((segment) => segment === '..') || entryNames.has(name)) {
      throw Object.assign(new Error('XLSX inventory contains an unsafe archive entry.'), { status: 400 });
    }
    entryNames.add(name);
    if (![0, 8].includes(method) || localOffset + 30 > centralOffset
      || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Object.assign(new Error('XLSX inventory contains an unsupported ZIP entry.'), { status: 400 });
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localExpandedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const localName = buffer.toString('utf8', localNameStart, localNameStart + localNameLength);
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || localName !== name || dataEnd > centralOffset
      || ((flags & 8) === 0 && (localCompressedSize !== compressedSize || localExpandedSize !== expandedSize))) {
      throw Object.assign(new Error('XLSX inventory has inconsistent ZIP entry metadata.'), { status: 400 });
    }
    if ((flags & 8) !== 0) {
      let descriptorOffset = dataEnd;
      if (descriptorOffset + 4 <= centralOffset && buffer.readUInt32LE(descriptorOffset) === 0x08074b50) {
        descriptorOffset += 4;
      }
      if (descriptorOffset + 12 > centralOffset
        || buffer.readUInt32LE(descriptorOffset + 4) !== compressedSize
        || buffer.readUInt32LE(descriptorOffset + 8) !== expandedSize) {
        throw Object.assign(new Error('XLSX inventory has an invalid ZIP data descriptor.'), { status: 400 });
      }
    }
    expandedBytes += expandedSize;
    if (expandedBytes > INVENTORY_LIMITS.maxExpandedBytes) {
      throw Object.assign(new Error(`XLSX inventory expands beyond the ${INVENTORY_LIMITS.maxExpandedBytes} byte limit.`), { status: 413 });
    }
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw Object.assign(new Error('XLSX inventory has an invalid ZIP directory length.'), { status: 400 });
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXml(bytes, filename) {
  if (!bytes) throw Object.assign(new Error(`XLSX inventory is missing ${filename}.`), { status: 400 });
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error(`XLSX inventory contains invalid XML in ${filename}.`), { status: 400 });
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw Object.assign(new Error(`XLSX inventory contains malformed XML in ${filename}.`), { status: 400 });
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    removeNSPrefix: false,
    trimValues: false,
    processEntities: false,
    maxNestedTags: 32,
  });
  try {
    return parser.parse(xml);
  } catch {
    throw Object.assign(new Error(`XLSX inventory contains malformed XML in ${filename}.`), { status: 400 });
  }
}

function textContent(value) {
  if (typeof value === 'string') {
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, value) => {
      if (value === 'amp') return '&';
      if (value === 'lt') return '<';
      if (value === 'gt') return '>';
      if (value === 'quot') return '"';
      if (value === 'apos') return '\'';
      const codePoint = value[0] === '#'
        ? value[1]?.toLowerCase() === 'x' ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10)
        : NaN;
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([key]) => key === 't' || key === '#text' || key === 'r')
    .map(([, item]) => textContent(item))
    .join('');
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/i.exec(reference ?? '')?.[1]?.toUpperCase();
  if (!letters) return -1;
  return [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function worksheetRows(xml, sharedStrings) {
  const document = parseXml(xml, 'worksheet XML');
  const rows = asArray(document.worksheet?.sheetData?.row);
  if (rows.length > INVENTORY_LIMITS.maxRows + 10) {
    throw Object.assign(new Error(`Worksheet exceeds the ${INVENTORY_LIMITS.maxRows} row limit.`), { status: 413 });
  }
  return rows.map((row) => {
    const values = [];
    for (const cell of asArray(row.c)) {
      const index = columnIndex(cell['@_r']);
      if (index < 0 || index > 100) {
        throw Object.assign(new Error('XLSX worksheet has an invalid or unsupported column reference.'), { status: 400 });
      }
      let value = cell.v ?? '';
      if (cell['@_t'] === 's') {
        const sharedIndex = Number(value);
        value = Number.isInteger(sharedIndex) && sharedIndex >= 0 ? sharedStrings[sharedIndex] ?? '' : '';
      } else if (cell['@_t'] === 'inlineStr') {
        value = textContent(cell.is);
      }
      values[index] = cellValue(value);
    }
    return values.map((value) => value ?? '');
  });
}

function unzipBounded(buffer) {
  const archive = Object.create(null);
  let expandedBytes = 0;
  let failure = null;
  const unzip = new Unzip((file) => {
    if (failure) return;
    if (file.originalSize > INVENTORY_LIMITS.maxExpandedEntryBytes) {
      failure = Object.assign(new Error('XLSX inventory contains an oversized archive entry.'), { status: 413 });
      return;
    }
    const chunks = [];
    let fileSize = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = Object.assign(new Error('XLSX inventory is malformed or cannot be read.'), { status: 400 });
        file.terminate();
        return;
      }
      fileSize += chunk.length;
      expandedBytes += chunk.length;
      if (fileSize > INVENTORY_LIMITS.maxExpandedEntryBytes || expandedBytes > INVENTORY_LIMITS.maxExpandedBytes) {
        failure = Object.assign(new Error('XLSX inventory expands beyond the allowed size.'), { status: 413 });
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const content = new Uint8Array(fileSize);
        let offset = 0;
        for (const part of chunks) {
          content.set(part, offset);
          offset += part.length;
        }
        archive[file.name] = content;
      }
    };
    try {
      file.start();
    } catch {
      failure = Object.assign(new Error('XLSX inventory uses an unsupported compression format.'), { status: 400 });
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(buffer, true);
  } catch {
    throw Object.assign(new Error('XLSX inventory is malformed or cannot be read.'), { status: 400 });
  }
  if (failure) throw failure;
  return archive;
}

function parseXlsxBuffer(buffer) {
  validateXlsxArchive(buffer);
  const archive = unzipBounded(buffer);
  if (!archive['xl/workbook.xml'] || !archive['xl/_rels/workbook.xml.rels']) {
    throw Object.assign(new Error('XLSX inventory is missing workbook metadata.'), { status: 400 });
  }
  const workbook = parseXml(archive['xl/workbook.xml'], 'workbook XML');
  const relations = parseXml(archive['xl/_rels/workbook.xml.rels'], 'workbook relationships');
  const sheets = asArray(workbook.workbook?.sheets?.sheet);
  if (!sheets.length || sheets.length > INVENTORY_LIMITS.maxSheets) {
    throw Object.assign(new Error(`XLSX inventory must contain between 1 and ${INVENTORY_LIMITS.maxSheets} worksheets.`), { status: 400 });
  }
  const unknown = sheets.filter((sheet) => !KNOWN_WORKSHEETS.has(String(sheet['@_name'] ?? '').trim().toLowerCase()));
  if (unknown.length) {
    throw Object.assign(new Error(`Unsupported worksheet name: ${unknown[0]['@_name']}.`), { status: 400 });
  }
  const relationships = new Map(asArray(relations.Relationships?.Relationship)
    .map((relationship) => [relationship['@_Id'], relationship['@_Target']]));
  const sharedStringsDocument = archive['xl/sharedStrings.xml']
    ? parseXml(archive['xl/sharedStrings.xml'], 'shared strings')
    : null;
  const sharedStrings = asArray(sharedStringsDocument?.sst?.si).map(textContent);

  const records = [];
  const ignoredWorksheets = [];
  for (const sheet of sheets) {
    const sheetName = String(sheet['@_name'] ?? '');
    if (sheetName.trim().toLowerCase() === 'read me') continue;
    const relationId = sheet['@_r:id'];
    const target = relationships.get(relationId);
    if (typeof target !== 'string' || target.includes('\\') || target.split('/').includes('..')) {
      throw Object.assign(new Error('XLSX workbook contains an invalid worksheet relationship.'), { status: 400 });
    }
    const worksheetPath = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join('xl', target));
    if (!worksheetPath.startsWith('xl/worksheets/')) {
      throw Object.assign(new Error('XLSX workbook references an unsupported worksheet location.'), { status: 400 });
    }
    const sheetBytes = archive[worksheetPath];
    if (!sheetBytes) throw Object.assign(new Error(`XLSX inventory is missing worksheet "${sheetName}".`), { status: 400 });
    const rows = worksheetRows(sheetBytes, sharedStrings);
    const headerRowLimit = Math.min(rows.length, 10);
    let indexes = null;
    let headerNumber = -1;
    for (let rowNumber = 0; rowNumber < headerRowLimit; rowNumber += 1) {
      const candidate = mapHeaders(headerMap(rows[rowNumber]));
      if (candidate.relativePath >= 0) {
        indexes = candidate;
        headerNumber = rowNumber;
        break;
      }
    }
    if (!indexes) {
      ignoredWorksheets.push(sheetName);
      continue;
    }
    for (let rowNumber = headerNumber + 1; rowNumber < rows.length; rowNumber += 1) {
      const record = recordFromRow(rows[rowNumber], indexes, sheetName);
      if (record.relativePath || record.name || record.parentFolder) records.push(record);
      if (records.length > INVENTORY_LIMITS.maxRows) {
        throw Object.assign(new Error(`Inventory exceeds the ${INVENTORY_LIMITS.maxRows} row limit.`), { status: 413 });
      }
    }
  }
  if (!records.length) {
    throw Object.assign(new Error('XLSX inventory has no supported worksheet with a RelativePath header.'), { status: 400 });
  }
  return { records, ignoredWorksheets };
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/[\\/]+/g, '/');
}

function pathKey(value) {
  return value.replace(/[\\/]+/g, '/').toLocaleLowerCase('en-US');
}

export async function importOrganizerInventory({ filename, contentType, buffer, root, entries }) {
  if (typeof filename !== 'string' || filename.length > 255) {
    throw Object.assign(new Error('Inventory filename is invalid.'), { status: 400 });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('Inventory file is empty.'), { status: 400 });
  }
  if (buffer.length > INVENTORY_LIMITS.maxBytes) {
    throw Object.assign(new Error(`Inventory file exceeds the ${INVENTORY_LIMITS.maxBytes} byte limit.`), { status: 413 });
  }
  const extension = path.extname(filename ?? '').toLowerCase();
  let parsed;
  if (extension === '.csv' && ['text/csv', 'text/plain', 'application/octet-stream', 'application/vnd.ms-excel'].includes(contentType)) {
    parsed = parseCsvBuffer(buffer);
  } else if (extension === '.xlsx'
    && ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'].includes(contentType)) {
    parsed = parseXlsxBuffer(buffer);
  } else {
    throw Object.assign(new Error('Only CSV and XLSX inventory files are supported.'), { status: 415 });
  }

  const { records, ignoredWorksheets } = parsed;
  const scannedByPath = new Map(entries.map((entry) => [pathKey(entry.relativePath), entry]));
  const importedByPath = new Map();
  const results = [];
  for (const record of records) {
    const relativePath = normalizeRelativePath(record.relativePath);
    let parentFolder = normalizeRelativePath(record.parentFolder);
    if (!relativePath) {
      if (parentFolder) {
        try {
          await resolvePathWithinRoot(root, parentFolder, { allowMissing: true });
        } catch {
          throw Object.assign(new Error('Inventory contains an invalid relative path.'), { status: 400, code: 'INVALID_LIBRARY_PATH' });
        }
      }
      results.push({ ...record, relativePath: null, parentFolder, match: 'unmatched', warnings: ['Inventory record has no relative path.'] });
      continue;
    }
    try {
      await resolvePathWithinRoot(root, relativePath, { allowMissing: true });
      if (parentFolder) await resolvePathWithinRoot(root, parentFolder, { allowMissing: true });
    } catch (error) {
      throw Object.assign(new Error('Inventory contains an invalid relative path.'), {
        status: 400,
        code: error.code ?? 'INVALID_LIBRARY_PATH',
      });
    }

    const scanned = scannedByPath.get(pathKey(relativePath));
    const previous = importedByPath.get(pathKey(relativePath));
    const warnings = [];
    if (previous) warnings.push('Multiple imported records refer to the same relative path.');
    if (scanned && record.name
      && path.basename(scanned.relativePath).toLocaleLowerCase('en-US') !== record.name.toLocaleLowerCase('en-US')) {
      warnings.push('Imported name conflicts with the scanned filename.');
    }
    importedByPath.set(pathKey(relativePath), record);
    results.push({
      ...record,
      relativePath,
      parentFolder,
      match: warnings.length ? 'conflict' : scanned ? 'matched' : 'unmatched',
      warnings,
    });
  }

  return {
    filename: path.posix.basename(path.win32.basename(filename)),
    importedAt: new Date().toISOString(),
    recordCount: results.length,
    matchedCount: results.filter((record) => record.match === 'matched').length,
    unmatchedCount: results.filter((record) => record.match === 'unmatched').length,
    conflictCount: results.filter((record) => record.match === 'conflict').length,
    ignoredWorksheets,
    warnings: ignoredWorksheets.map((worksheet) =>
      `Worksheet "${worksheet}" has no supported relative-path column and was not compared.`),
    records: results,
  };
}
