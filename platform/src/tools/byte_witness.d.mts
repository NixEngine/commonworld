/** Original byte-preserving CSV engine; diagnostic text is never normalized in place. */
export type Span = [number, number];
export interface Options {
  maxOutputBytes?: number;
  sha256?: (bytes: Uint8Array) => Promise<string | ArrayBuffer | Uint8Array> | string | ArrayBuffer | Uint8Array;
}
export interface Field {
  index: number; rawSpan: Span; quoted: boolean; logicalText: string;
  logicalCodePoints: string[]; logicalCodePointSpans: Span[]; escapePairSpans: Span[];
}
export interface RecordWitness {
  index: number; rawSpan: Span; terminator: { kind: 'CRLF' | 'LF' | 'CR' | 'EOF'; span: Span }; fields: Field[];
}
export interface Inspection {
  format: string; sha256: string; byteLength: number;
  limits: { maxInputBytes: number; maxRows: number; maxFieldsPerRow: number; maxOutputBytes: number; rowsIncludeHeader: boolean };
  encoding: { label: string; bomSpan: Span; payloadOffset: number };
  records: RecordWitness[]; warnings: unknown[];
}
export interface Comparison {
  format: string; keyColumn: string; byteIdentical: boolean; comparisonComplete: boolean;
  source: { sha256: string; byteLength: number; [key: string]: unknown };
  exported: { sha256: string; byteLength: number; [key: string]: unknown };
  columns: { source: string[]; exported: string[]; missing: { name: string; headerSpan: Span }[]; extra: { name: string; headerSpan: Span }[] };
  missingKeys: unknown[]; extraKeys: unknown[]; duplicateKeys: { source: unknown[]; exported: unknown[] };
  ambiguousKeys: unknown[]; cellDifferences: unknown[]; terminatorDifferences: unknown[];
  warnings: unknown[]; summary: { [key: string]: number };
}
export const LIMITS: Readonly<{ maxInputBytes: number; maxRows: number; maxFieldsPerRow: number; maxOutputBytes: number }>;
export class ByteWitnessError extends Error {
  code: string; byteOffset?: number; side?: string;
  constructor(code: string, byteOffset?: number, side?: string);
  toJSON(): { error: string; byteOffset?: number; side?: string };
}
export function inspectCsv(bytes: Uint8Array, options?: Options): Promise<Inspection>;
export function compareCsv(source: Uint8Array, exported: Uint8Array, keyColumn: string, options?: Options): Promise<Comparison>;
