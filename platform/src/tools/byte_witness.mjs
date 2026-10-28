/** Pure byte-preserving UTF-8 CSV witnesses. No filesystem, network or credentials. */
export const LIMITS = Object.freeze({
  maxInputBytes: 65_536, maxRows: 512, maxFieldsPerRow: 64, maxOutputBytes: 1_048_576,
});
const encoder = new TextEncoder();
const CP = n => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');
const jsonBytes = value => encoder.encode(JSON.stringify(value)).byteLength;

export class ByteWitnessError extends Error {
  constructor(code, byteOffset, side) {
    super(code);
    this.name = 'ByteWitnessError';
    this.code = code;
    if (byteOffset !== undefined) this.byteOffset = byteOffset;
    if (side !== undefined) this.side = side;
  }
  toJSON() {
    return { error: this.code, ...(this.byteOffset === undefined ? {} : { byteOffset: this.byteOffset }),
      ...(this.side === undefined ? {} : { side: this.side }) };
  }
}
const fail = (code, offset, side) => { throw new ByteWitnessError(code, offset, side); };

function outputLimit(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('OPTIONS_TYPE');
  const n = options.maxOutputBytes ?? LIMITS.maxOutputBytes;
  if (!Number.isSafeInteger(n) || n < 256 || n > LIMITS.maxOutputBytes) fail('INVALID_OUTPUT_LIMIT');
  return n;
}
class Budget {
  constructor(limit, initial) { this.limit = limit; this.used = jsonBytes(initial); this.check(); }
  check() { if (this.used > this.limit) fail('OUTPUT_LIMIT'); }
  add(value, comma = false) { this.used += jsonBytes(value) + Number(comma); this.check(); }
  stringPart(value) { this.used += jsonBytes(value) - 2; this.check(); }
}
function snapshot(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('INPUT_TYPE');
  if (bytes.byteLength > LIMITS.maxInputBytes) fail('INPUT_LIMIT');
  // Copy synchronously before the first await; caller mutation cannot change a witness.
  return Uint8Array.from(bytes);
}

function scalarAt(bytes, at) {
  const first = bytes[at];
  if (first < 0x80) return [first, 1];
  let count, value, minimum;
  if (first >= 0xC2 && first <= 0xDF) { count = 2; value = first & 31; minimum = 0x80; }
  else if (first >= 0xE0 && first <= 0xEF) { count = 3; value = first & 15; minimum = 0x800; }
  else if (first >= 0xF0 && first <= 0xF4) { count = 4; value = first & 7; minimum = 0x10000; }
  else fail('INVALID_UTF8', at);
  if (at + count > bytes.length) fail('INVALID_UTF8', at);
  for (let i = 1; i < count; i++) {
    const next = bytes[at + i];
    if (next < 0x80 || next > 0xBF) fail('INVALID_UTF8', at + i);
    value = (value << 6) | (next & 63);
  }
  if (value < minimum || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) fail('INVALID_UTF8', at);
  return [value, count];
}
function encodingOf(bytes) {
  const starts = prefix => prefix.every((n, i) => bytes[i] === n);
  if (starts([0xFF, 0xFE, 0, 0]) || starts([0, 0, 0xFE, 0xFF]) ||
      starts([0xFF, 0xFE]) || starts([0xFE, 0xFF])) fail('UNSUPPORTED_ENCODING', 0);
  const bom = starts([0xEF, 0xBB, 0xBF]);
  const offset = bom ? 3 : 0;
  for (let at = offset; at < bytes.length;) at += scalarAt(bytes, at)[1];
  return { label: bom ? 'utf-8-bom' : 'utf-8-no-bom', bomSpan: [0, offset], payloadOffset: offset };
}
function terminator(bytes, at) {
  if (bytes[at] === 13) return { kind: bytes[at + 1] === 10 ? 'CRLF' : 'CR', length: bytes[at + 1] === 10 ? 2 : 1 };
  if (bytes[at] === 10) return { kind: 'LF', length: 1 };
  return null;
}

function nfcGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const normalized = entry.text.normalize('NFC'); // Diagnostic only; never a lookup/rewrite key.
    const groupKey = JSON.stringify([entry.scope, normalized]);
    if (!groups.has(groupKey)) groups.set(groupKey, { scope: entry.scope, normalized, variants: new Map() });
    const group = groups.get(groupKey);
    if (!group.variants.has(entry.text)) group.variants.set(entry.text, []);
    group.variants.get(entry.text).push(entry.ref);
  }
  const warnings = [];
  for (const group of groups.values()) {
    if (group.variants.size < 2) continue;
    warnings.push({ code: 'NFC_COLLISION', scope: group.scope,
      nfcCodePoints: Array.from(group.normalized, c => CP(c.codePointAt(0))),
      variants: Array.from(group.variants, ([logicalText, occurrences]) => ({ logicalText, occurrences })) });
  }
  return warnings;
}

function parse(bytes, limit) {
  const encoding = encodingOf(bytes);
  const result = { format: 'byte-witness/csv-r1', sha256: '0'.repeat(64), byteLength: bytes.length,
    encoding, limits: { ...LIMITS, maxOutputBytes: limit, rowsIncludeHeader: true }, records: [], warnings: [] };
  const budget = new Budget(limit, result);
  let at = encoding.payloadOffset;
  while (at < bytes.length) {
    if (result.records.length >= LIMITS.maxRows) fail('ROW_LIMIT', at);
    const recordStart = at, fields = [];
    let end, ending;
    while (true) {
      if (fields.length >= LIMITS.maxFieldsPerRow) fail('FIELD_LIMIT', at);
      const fieldStart = at, quoted = bytes[at] === 34;
      const pieces = [], points = [], pointSpans = [], escapes = [];
      const point = (value, start, stop, escaped = false) => {
        const char = String.fromCodePoint(value), label = CP(value), span = [start, stop];
        budget.stringPart(char);
        budget.add(label, points.length > 0);
        budget.add(span, pointSpans.length > 0);
        if (escaped) { budget.add(span, escapes.length > 0); escapes.push(span); }
        pieces.push(char); points.push(label); pointSpans.push(span);
      };
      if (quoted) {
        at++;
        while (true) {
          if (at >= bytes.length) fail('UNTERMINATED_QUOTE', at);
          if (bytes[at] === 34) {
            if (bytes[at + 1] === 34) { point(34, at, at + 2, true); at += 2; continue; }
            at++;
            if (at < bytes.length && bytes[at] !== 44 && !terminator(bytes, at)) fail('AFTER_CLOSING_QUOTE', at);
            break;
          }
          const [value, length] = scalarAt(bytes, at);
          point(value, at, at + length); at += length;
        }
      } else {
        while (at < bytes.length && bytes[at] !== 44 && !terminator(bytes, at)) {
          if (bytes[at] === 34) fail('QUOTE_IN_UNQUOTED_FIELD', at);
          const [value, length] = scalarAt(bytes, at);
          point(value, at, at + length); at += length;
        }
      }
      const field = { index: fields.length, rawSpan: [fieldStart, at], quoted,
        logicalText: pieces.join(''), logicalCodePoints: points,
        logicalCodePointSpans: pointSpans, escapePairSpans: escapes };
      // Array/string contents were charged incrementally; charge their JSON shell now.
      budget.add({ ...field, logicalText: '', logicalCodePoints: [], logicalCodePointSpans: [], escapePairSpans: [] }, fields.length > 0);
      fields.push(field);
      if (at >= bytes.length) { end = at; ending = { kind: 'EOF', span: [at, at] }; break; }
      if (bytes[at] === 44) { at++; continue; } // Includes a final empty field after a comma.
      const term = terminator(bytes, at);
      end = at; at += term.length;
      ending = { kind: term.kind, span: [end, at] };
      break;
    }
    const record = { index: result.records.length, rawSpan: [recordStart, end], terminator: ending, fields };
    budget.add({ ...record, fields: [] }, result.records.length > 0);
    result.records.push(record);
  }
  const entries = [];
  for (const row of result.records) for (const field of row.fields) entries.push({
    scope: 'field-position:' + field.index, text: field.logicalText,
    ref: { record: row.index, field: field.index, rawSpan: field.rawSpan },
  });
  for (const warning of nfcGroups(entries)) { budget.add(warning, result.warnings.length > 0); result.warnings.push(warning); }
  if (result.records.length) {
    const width = result.records[0].fields.length;
    for (const row of result.records.slice(1)) if (row.fields.length !== width) {
      const warning = { code: 'ROW_WIDTH_MISMATCH', record: row.index, expected: width, observed: row.fields.length, rawSpan: row.rawSpan };
      budget.add(warning, result.warnings.length > 0); result.warnings.push(warning);
    }
  }
  return result;
}
async function digest(bytes, provider) {
  let value;
  try {
    value = provider ? await provider(bytes.slice()) : await globalThis.crypto.subtle.digest('SHA-256', bytes);
  } catch { fail('HASH_FAILURE'); }
  if (typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (value instanceof Uint8Array && value.byteLength === 32) return Array.from(value, n => n.toString(16).padStart(2, '0')).join('');
  fail('HASH_PROVIDER_RESULT');
}
function finalBound(result, limit) { if (jsonBytes(result) > limit) fail('OUTPUT_LIMIT'); return result; }

/** Snapshot and inspect strict UTF-8 CSV. Spans are zero-based, half-open byte offsets. */
export async function inspectCsv(bytes, options = {}) {
  const limit = outputLimit(options), copy = snapshot(bytes);
  if (options.sha256 !== undefined && typeof options.sha256 !== 'function') fail('HASH_PROVIDER_TYPE');
  const result = parse(copy, limit);
  result.sha256 = await digest(copy, options.sha256);
  return finalBound(result, limit);
}

function equalSpan(a, spanA, b, spanB) {
  if (spanA[1] - spanA[0] !== spanB[1] - spanB[0]) return false;
  for (let i = 0; i < spanA[1] - spanA[0]; i++) if (a[spanA[0] + i] !== b[spanB[0] + i]) return false;
  return true;
}
function headerMap(report, keyColumn, side) {
  if (!report.records.length) fail('NO_HEADER', 0, side);
  const header = report.records[0], map = new Map();
  for (const field of header.fields) {
    if (map.has(field.logicalText)) fail('AMBIGUOUS_HEADER', field.rawSpan[0], side);
    map.set(field.logicalText, field.index);
  }
  if (!map.has(keyColumn)) fail('KEY_COLUMN_NOT_FOUND', header.rawSpan[0], side);
  return map;
}
function rowIndex(report, keyAt, side) {
  const map = new Map();
  for (const row of report.records.slice(1)) {
    const field = row.fields[keyAt];
    if (!field) fail('MISSING_KEY_CELL', row.rawSpan[0], side);
    const key = field.logicalText;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}
const rowRef = (row, keyAt) => ({ record: row.index, rawSpan: row.rawSpan, keySpan: row.fields[keyAt].rawSpan });
const fieldRef = (row, field) => field ? ({ record: row.index, field: field.index, rawSpan: field.rawSpan,
  logicalText: field.logicalText, logicalCodePoints: field.logicalCodePoints }) : null;

/** Compare exact logical keys. Duplicate keys are reported, never paired by guessed order. */
export async function compareCsv(sourceBytes, exportBytes, keyColumn, options = {}) {
  if (typeof keyColumn !== 'string' || !keyColumn.length || keyColumn.length > 128) fail('KEY_COLUMN_TYPE');
  const limit = outputLimit(options), sourceCopy = snapshot(sourceBytes), exportCopy = snapshot(exportBytes);
  // Keep the two snapshots stable even when a caller mutates either original during hashing.
  const source = await inspectCsv(sourceCopy, options), exported = await inspectCsv(exportCopy, options);
  const sourceHeaders = headerMap(source, keyColumn, 'source');
  const exportHeaders = headerMap(exported, keyColumn, 'exported');
  const sourceKeyAt = sourceHeaders.get(keyColumn), exportKeyAt = exportHeaders.get(keyColumn);
  const sourceRows = rowIndex(source, sourceKeyAt, 'source'), exportRows = rowIndex(exported, exportKeyAt, 'exported');
  const result = {
    format: 'byte-witness/csv-comparison-r1', keyColumn,
    source: { sha256: source.sha256, byteLength: source.byteLength, encoding: source.encoding,
      recordCount: source.records.length, dataRows: Math.max(0, source.records.length - 1),
      headerRawSpan: source.records[0].rawSpan, headerTerminator: source.records[0].terminator },
    exported: { sha256: exported.sha256, byteLength: exported.byteLength, encoding: exported.encoding,
      recordCount: exported.records.length, dataRows: Math.max(0, exported.records.length - 1),
      headerRawSpan: exported.records[0].rawSpan, headerTerminator: exported.records[0].terminator },
    byteIdentical: equalSpan(sourceCopy, [0, sourceCopy.length], exportCopy, [0, exportCopy.length]),
    comparisonComplete: false,
    columns: { source: [...sourceHeaders.keys()], exported: [...exportHeaders.keys()], missing: [], extra: [] },
    missingKeys: [], extraKeys: [], duplicateKeys: { source: [], exported: [] }, ambiguousKeys: [],
    cellDifferences: [], terminatorDifferences: [], warnings: [],
    summary: { missingMultiplicity: 0, extraMultiplicity: 0, ambiguousKeys: 0, matchedUniqueKeys: 0,
      logicalDifferences: 0, normalizationOnlyDifferences: 0, rawOnlyDifferences: 0, missingCells: 0 },
  };
  const budget = new Budget(limit, result);
  const push = (array, value) => { budget.add(value, array.length > 0); array.push(value); };
  for (const name of sourceHeaders.keys()) if (!exportHeaders.has(name)) push(result.columns.missing, { name, headerSpan: source.records[0].fields[sourceHeaders.get(name)].rawSpan });
  for (const name of exportHeaders.keys()) if (!sourceHeaders.has(name)) push(result.columns.extra, { name, headerSpan: exported.records[0].fields[exportHeaders.get(name)].rawSpan });
  for (const [side, map, keyAt] of [['source', sourceRows, sourceKeyAt], ['exported', exportRows, exportKeyAt]]) {
    for (const [key, rows] of map) if (rows.length > 1) push(result.duplicateKeys[side], { key, count: rows.length, rows: rows.map(row => rowRef(row, keyAt)) });
  }
  for (const key of new Set([...sourceRows.keys(), ...exportRows.keys()])) {
    const a = sourceRows.get(key) ?? [], b = exportRows.get(key) ?? [];
    if (a.length > b.length) {
      push(result.missingKeys, { key, count: a.length - b.length, sourceCount: a.length, exportCount: b.length,
        sourceRows: a.map(row => rowRef(row, sourceKeyAt)), exportRows: b.map(row => rowRef(row, exportKeyAt)) });
      result.summary.missingMultiplicity += a.length - b.length;
    }
    if (b.length > a.length) {
      push(result.extraKeys, { key, count: b.length - a.length, sourceCount: a.length, exportCount: b.length,
        sourceRows: a.map(row => rowRef(row, sourceKeyAt)), exportRows: b.map(row => rowRef(row, exportKeyAt)) });
      result.summary.extraMultiplicity += b.length - a.length;
    }
    if (!a.length || !b.length) continue;
    if (a.length !== 1 || b.length !== 1) {
      push(result.ambiguousKeys, { key, sourceCount: a.length, exportCount: b.length });
      result.summary.ambiguousKeys++;
      continue;
    }
    result.summary.matchedUniqueKeys++;
    for (const [name, i] of sourceHeaders) {
      if (!exportHeaders.has(name)) continue;
      const left = a[0].fields[i], right = b[0].fields[exportHeaders.get(name)];
      let kind;
      if (!left || !right) { if (!left && !right) continue; kind = 'missing_cell'; result.summary.missingCells++; }
      else if (left.logicalText !== right.logicalText) {
        kind = left.logicalText.normalize('NFC') === right.logicalText.normalize('NFC') ? 'normalization_only' : 'logical';
        result.summary[kind === 'normalization_only' ? 'normalizationOnlyDifferences' : 'logicalDifferences']++;
      } else if (!equalSpan(sourceCopy, left.rawSpan, exportCopy, right.rawSpan)) { kind = 'raw_only'; result.summary.rawOnlyDifferences++; }
      if (kind) push(result.cellDifferences, { key, column: name, kind, source: fieldRef(a[0], left), exported: fieldRef(b[0], right) });
    }
    if (a[0].terminator.kind !== b[0].terminator.kind) push(result.terminatorDifferences, {
      key, source: { record: a[0].index, ...a[0].terminator }, exported: { record: b[0].index, ...b[0].terminator },
    });
  }
  for (const [side, report] of [['source', source], ['exported', exported]]) {
    for (const warning of report.warnings) push(result.warnings, { side, ...warning });
  }
  const keyEntries = [];
  for (const [side, map, keyAt] of [['source', sourceRows, sourceKeyAt], ['exported', exportRows, exportKeyAt]]) {
    for (const [key, rows] of map) for (const row of rows) keyEntries.push({ scope: 'key-column', text: key, ref: { side, ...rowRef(row, keyAt) } });
  }
  for (const warning of nfcGroups(keyEntries)) push(result.warnings, warning);
  result.comparisonComplete = result.ambiguousKeys.length === 0 && !result.warnings.some(w => w.code === 'ROW_WIDTH_MISMATCH');
  // Counter digit growth is checked against the exact final JSON byte size too.
  return finalBound(result, limit);
}
