/** Stateless CSV diagnostics. Uploaded bytes are never saved, fetched or logged. */
import type { Ctx } from '../context';
import { HttpError, json, MAX_BODY_BYTES, readJson } from '../http';
import { ByteWitnessError, compareCsv, inspectCsv, LIMITS } from '../tools/byte_witness.mjs';

export const CSV_WITNESS_PATH = '/tools/csv-witness';
export const CSV_WITNESS_API = '/v1/tools/csv-witness';
export const CSV_WITNESS_NOTE = 'Exact-byte UTF-8 CSV diagnostics, not a certificate of safety or correctness. No trimming, normalization, repair or formula execution. The local browser tool never uploads selected files; the optional API processes bytes in memory without storing them.';

export function csvWitnessDescription() {
  return {
    name: 'CSV Byte Witness', version: '1', html: CSV_WITNESS_PATH,
    markdown: `${CSV_WITNESS_PATH}.md`, api: CSV_WITNESS_API,
    modes: ['inspect', 'compare'], input: 'canonical padded base64 of original UTF-8 CSV bytes',
    limits: { ...LIMITS, apiJsonBodyBytes: MAX_BODY_BYTES },
    spanConvention: 'zero-based half-open byte offsets [start,end)',
    privacy: { persistence: false, outboundFetches: false, fileUploadsInBrowser: false },
    note: CSV_WITNESS_NOTE,
  };
}

export async function describeCsvWitness(_c: Ctx): Promise<Response> {
  return json(200, csvWitnessDescription());
}

function bytes(value: unknown): Uint8Array {
  // Canonical padding also rejects ambiguous unused pad bits; empty CSV is valid.
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(LIMITS.maxInputBytes / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(400, 'invalid_csv_base64');
  }
  let decoded: string;
  try { decoded = atob(value); } catch { throw new HttpError(400, 'invalid_csv_base64'); }
  if (btoa(decoded) !== value) throw new HttpError(400, 'invalid_csv_base64');
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

export async function runCsvWitness(c: Ctx): Promise<Response> {
  // Existing bounded stream reader enforces 16 KiB BEFORE JSON.parse, also without Content-Length.
  const body = await readJson(c.request);
  const mode = body.mode;
  if (mode !== 'inspect' && mode !== 'compare') throw new HttpError(400, 'invalid_csv_mode');
  const allowed = mode === 'inspect' ? ['mode', 'source_base64'] : ['mode', 'source_base64', 'exported_base64', 'key_column'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new HttpError(400, 'unknown_csv_field');
  const source = bytes(body.source_base64);
  if (mode === 'compare' && (typeof body.key_column !== 'string' || !body.key_column.length || body.key_column.length > 128)) {
    throw new HttpError(400, 'invalid_csv_key_column');
  }
  const exported = mode === 'compare' ? bytes(body.exported_base64) : null;
  try {
    const result = exported === null ? await inspectCsv(source) : await compareCsv(source, exported, body.key_column as string);
    return json(200, result);
  } catch (error) {
    if (!(error instanceof ByteWitnessError)) throw new HttpError(500, 'csv_witness_failed');
    // Only fixed codes / offsets: never echo the supplied CSV, file names or a stack.
    throw new HttpError(422, 'invalid_csv', {
      csv_code: error.code,
      ...(error.byteOffset === undefined ? {} : { byte_offset: error.byteOffset }),
      ...(error.side === undefined ? {} : { side: error.side }),
    });
  }
}
