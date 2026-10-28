import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectCsv, compareCsv, LIMITS, ByteWitnessError } from '../src/tools/byte_witness.mjs';

const encode = text => new TextEncoder().encode(text);
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const rejects = (promise, code, offset) => assert.rejects(promise, error =>
  error instanceof ByteWitnessError && error.code === code && (offset === undefined || error.byteOffset === offset));

test('fixture 01: ASCII record/field spans exclude exact CRLF and LF terminators', async () => {
  const bytes = encode('a,b\r\nc,d\n');
  const result = await inspectCsv(bytes);
  assert.equal(result.sha256, hex(bytes));
  assert.deepEqual(result.records.map(row => [row.rawSpan, row.terminator, row.fields.map(f => f.rawSpan)]), [
    [[0, 3], { kind: 'CRLF', span: [3, 5] }, [[0, 1], [2, 3]]],
    [[5, 8], { kind: 'LF', span: [8, 9] }, [[5, 6], [7, 8]]],
  ]);
});

test('fixture 02: leading BOM is metadata; embedded BOM, non-BMP and VS16 stay data', async () => {
  const bytes = encode('\uFEFFé,\uFEFF🕊️\r\n');
  const result = await inspectCsv(bytes);
  assert.deepEqual(result.encoding, { label: 'utf-8-bom', bomSpan: [0, 3], payloadOffset: 3 });
  assert.deepEqual(result.records[0].rawSpan, [3, 16]);
  assert.deepEqual(result.records[0].terminator, { kind: 'CRLF', span: [16, 18] });
  assert.deepEqual(result.records[0].fields[0].logicalCodePointSpans, [[3, 5]]);
  const field = result.records[0].fields[1];
  assert.equal(field.logicalText, '\uFEFF🕊️');
  assert.deepEqual(field.logicalCodePoints, ['U+FEFF', 'U+1F54A', 'U+FE0F']);
  assert.deepEqual(field.logicalCodePointSpans, [[6, 9], [9, 13], [13, 16]]);
});

test('fixture 03: doubled quote maps one logical scalar to both original quote bytes', async () => {
  const result = await inspectCsv(encode('"a""b\nc",z\r'));
  const row = result.records[0], field = row.fields[0];
  assert.deepEqual(row.rawSpan, [0, 10]);
  assert.deepEqual(row.terminator, { kind: 'CR', span: [10, 11] });
  assert.deepEqual(field.rawSpan, [0, 8]);
  assert.equal(field.logicalText, 'a"b\nc');
  assert.deepEqual(field.logicalCodePoints, ['U+0061', 'U+0022', 'U+0062', 'U+000A', 'U+0063']);
  assert.deepEqual(field.logicalCodePointSpans, [[1, 2], [2, 4], [4, 5], [5, 6], [6, 7]]);
  assert.deepEqual(field.escapePairSpans, [[2, 4]]);
});

test('fixture 04: empty cells, final comma and blank records have real zero-width spans', async () => {
  const result = await inspectCsv(encode(',\r\nx,,\n\n'));
  assert.deepEqual(result.records.map(r => r.fields.map(f => f.rawSpan)), [
    [[0, 0], [1, 1]], [[3, 4], [5, 5], [6, 6]], [[7, 7]],
  ]);
  assert.equal(result.records.length, 3); // No phantom record after a final newline.
  const final = await inspectCsv(encode('a,'));
  assert.deepEqual(final.records[0].fields[1].rawSpan, [2, 2]);
  assert.deepEqual(final.records[0].terminator, { kind: 'EOF', span: [2, 2] });
  assert.equal((await inspectCsv(new Uint8Array())).records.length, 0);
  assert.equal((await inspectCsv(encode('\uFEFF'))).records.length, 0);
});

test('fixture 05: strict UTF-8 rejects overlong, surrogate, out-of-range and broken sequences', async () => {
  for (const bytes of [[0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xF4, 0x90, 0x80, 0x80],
    [0xE2, 0x82], [0x80], [0xF0, 0x28, 0x8C, 0xBC]]) {
    await rejects(inspectCsv(Uint8Array.from(bytes)), 'INVALID_UTF8');
  }
  for (const bytes of [[0xFF, 0xFE], [0xFE, 0xFF], [0xFF, 0xFE, 0, 0], [0, 0, 0xFE, 0xFF]]) {
    await rejects(inspectCsv(Uint8Array.from(bytes)), 'UNSUPPORTED_ENCODING', 0);
  }
});

test('fixture 06: malformed CSV quotes retain the exact failing byte offset', async () => {
  for (const [text, code, offset] of [
    ['a"b', 'QUOTE_IN_UNQUOTED_FIELD', 1], ['"a"oops', 'AFTER_CLOSING_QUOTE', 3],
    ['"a" ', 'AFTER_CLOSING_QUOTE', 3], ['"unterminated', 'UNTERMINATED_QUOTE', 13],
  ]) await rejects(inspectCsv(encode(text)), code, offset);
});

test('fixture 07: input, row, field and output ceilings are enforced at their boundary', async () => {
  await rejects(inspectCsv(new Uint8Array(65_537)), 'INPUT_LIMIT');
  assert.equal((await inspectCsv(encode('\n'.repeat(512)))).records.length, 512);
  await rejects(inspectCsv(encode('\n'.repeat(513))), 'ROW_LIMIT');
  assert.equal((await inspectCsv(encode(','.repeat(63)))).records[0].fields.length, 64);
  await rejects(inspectCsv(encode(','.repeat(64))), 'FIELD_LIMIT');
  const maximum = encode('😀'.repeat(16_384));
  assert.equal(maximum.length, LIMITS.maxInputBytes);
  assert.equal((await inspectCsv(maximum)).byteLength, 65_536);
  await rejects(inspectCsv(encode('a'.repeat(512)), { maxOutputBytes: 1024 }), 'OUTPUT_LIMIT');
  await rejects(inspectCsv(encode('a'), { maxOutputBytes: LIMITS.maxOutputBytes + 1 }), 'INVALID_OUTPUT_LIMIT');
  await rejects(inspectCsv('not bytes'), 'INPUT_TYPE');
  await rejects(inspectCsv(encode('a'), null), 'OPTIONS_TYPE');
});

test('fixture 08: NFC warning preserves both original values and byte arrays', async () => {
  const bytes = encode('é\ne\u0301\n'), saved = bytes.slice();
  const result = await inspectCsv(bytes);
  assert.deepEqual(bytes, saved);
  assert.deepEqual(result.records.map(r => r.fields[0].logicalText), ['é', 'e\u0301']);
  assert.deepEqual(result.records[0].fields[0].rawSpan, [0, 2]);
  assert.deepEqual(result.records[1].fields[0].rawSpan, [3, 6]);
  const collision = result.warnings.find(w => w.code === 'NFC_COLLISION');
  assert.deepEqual(collision.nfcCodePoints, ['U+00E9']);
  assert.equal(collision.variants.length, 2);
  assert.equal(result.sha256, hex(saved));
});

test('fixture 09: SHA injection and subarray snapshot survive caller mutation during await', async () => {
  const carrier = Uint8Array.from([88, 97, 44, 98, 89]), view = carrier.subarray(1, 4);
  const pending = inspectCsv(view, { sha256: async copy => { await Promise.resolve(); return hex(copy); } });
  view.fill(120);
  const result = await pending;
  assert.equal(result.byteLength, 3);
  assert.equal(result.sha256, hex(encode('a,b')));
  assert.equal(result.records[0].fields[0].logicalText, 'a');
  assert.equal(carrier[0], 88); assert.equal(carrier[4], 89);
  await rejects(inspectCsv(encode('x'), { sha256: async () => 'bad' }), 'HASH_PROVIDER_RESULT');
  await rejects(inspectCsv(encode('x'), { sha256: async () => { throw Error('PRIVATE_ENV_DETAIL'); } }), 'HASH_FAILURE');
});

test('fixture 10: comparison counts missing/extra multiplicities without pairing duplicate keys', async () => {
  const result = await compareCsv(encode('id,v\n1,a\n2,b\n2,c\n4,d\n'), encode('id,v\n1,a\n2,b\n3,c\n'), 'id');
  assert.deepEqual(result.missingKeys.map(x => [x.key, x.count]), [['2', 1], ['4', 1]]);
  assert.deepEqual(result.extraKeys.map(x => [x.key, x.count]), [['3', 1]]);
  assert.deepEqual(result.duplicateKeys.source[0].rows.map(x => x.rawSpan), [[9, 12], [13, 16]]);
  assert.deepEqual(result.ambiguousKeys, [{ key: '2', sourceCount: 2, exportCount: 1 }]);
  assert.equal(result.summary.matchedUniqueKeys, 1);
  assert.equal(result.comparisonComplete, false);
  assert.equal(result.summary.missingMultiplicity, 2);
  assert.equal(result.cellDifferences.length, 0);
});

test('fixture 11: compare distinguishes raw quote changes, normalization-only and logical loss', async () => {
  const a = encode('id,a,b,c\n1,"x",e\u0301,old\r\n'), b = encode('id,a,b,c\n1,x,é,new\n');
  const savedA = a.slice(), savedB = b.slice();
  const result = await compareCsv(a, b, 'id');
  assert.deepEqual(result.cellDifferences.map(d => [d.column, d.kind]), [
    ['a', 'raw_only'], ['b', 'normalization_only'], ['c', 'logical'],
  ]);
  assert.deepEqual(result.cellDifferences[0].source.rawSpan, [11, 14]);
  assert.deepEqual(result.cellDifferences[0].exported.rawSpan, [11, 12]);
  assert.deepEqual(result.cellDifferences[1].source.rawSpan, [15, 18]);
  assert.deepEqual(result.cellDifferences[1].exported.rawSpan, [13, 15]);
  assert.deepEqual(result.terminatorDifferences[0].source.span, [22, 24]);
  assert.deepEqual(result.terminatorDifferences[0].exported.span, [19, 20]);
  assert.equal(result.source.sha256, hex(a)); assert.equal(result.exported.sha256, hex(b));
  assert.deepEqual(a, savedA); assert.deepEqual(b, savedB);
});

test('fixture 12: header alignment is exact; normalized keys never merge; ragged data is explicit', async () => {
  const reordered = await compareCsv(encode('id,value\n1,x\n'), encode('value,id\nx,1\n'), 'id');
  assert.equal(reordered.summary.matchedUniqueKeys, 1);
  assert.equal(reordered.comparisonComplete, true);
  assert.equal(reordered.cellDifferences.length, 0);
  assert.equal(reordered.byteIdentical, false);
  const changedKey = await compareCsv(encode('id,value\né,x\n'), encode('value,id\nx,e\u0301\n'), 'id');
  assert.equal(changedKey.missingKeys[0].key, 'é');
  assert.equal(changedKey.extraKeys[0].key, 'e\u0301');
  assert.equal(changedKey.summary.matchedUniqueKeys, 0);
  assert(changedKey.warnings.some(w => w.scope === 'key-column' && w.code === 'NFC_COLLISION'));
  const ragged = await compareCsv(encode('id,v\n1\n'), encode('id,v\n1,x\n'), 'id');
  assert.equal(ragged.cellDifferences[0].kind, 'missing_cell');
  assert.equal(ragged.comparisonComplete, false);
  assert.equal(ragged.cellDifferences[0].source, null);
  assert.deepEqual(ragged.cellDifferences[0].exported.rawSpan, [7, 8]);
  assert(ragged.warnings.some(w => w.code === 'ROW_WIDTH_MISMATCH' && w.side === 'source'));
  await rejects(compareCsv(encode('id,id\n1,2\n'), encode('id,v\n1,x\n'), 'id'), 'AMBIGUOUS_HEADER');
  await rejects(compareCsv(encode('x\n1\n'), encode('x\n1\n'), 'id'), 'KEY_COLUMN_NOT_FOUND');
  await rejects(compareCsv(new Uint8Array(), encode('id\n1\n'), 'id'), 'NO_HEADER');
});
