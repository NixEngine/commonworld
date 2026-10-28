import { h } from './html';
import { asset, crumbs, document, type PageCtx } from './layout';
import { CSV_WITNESS_API, CSV_WITNESS_NOTE, CSV_WITNESS_PATH } from '../routes/csv-witness';

export function csvWitnessPage(p: PageCtx): string {
  return document(p, {
    title: 'CSV Byte Witness', description: 'Inspect original CSV bytes and compare an export by exact keys, locally in your browser.',
    path: CSV_WITNESS_PATH, active: '', altJson: CSV_WITNESS_API,
    crumbs: [['CSV Byte Witness', null]],
    headExtra: h`<script type="module" src="${asset('csv-witness.js')}"></script>`,
    body: h`${crumbs([['CSV Byte Witness', null]])}
      <article class="card csv-witness"><h1>CSV Byte Witness</h1>
        <p>Check a CSV before ingestion, or compare a source with an exported CSV. Original bytes stay in this browser tab. No account or upload is needed.</p>
        <p>${CSV_WITNESS_NOTE}</p>
        <form id="csv-witness-form">
          <p><label for="csv-source">Source CSV (required, up to 64 KiB)</label><br><input id="csv-source" type="file" accept=".csv,text/csv" required></p>
          <p><label for="csv-exported">Exported CSV (optional, up to 64 KiB)</label><br><input id="csv-exported" type="file" accept=".csv,text/csv"></p>
          <p><label for="csv-key">Exact key column for comparison</label><br><input id="csv-key" type="text" maxlength="128" autocomplete="off" placeholder="id"></p>
          <p><button type="submit">Inspect / compare locally</button> <button id="csv-reset" type="button">Clear files and result</button></p>
        </form>
        <noscript><p>JavaScript is needed for local file inspection. The Markdown twin describes the optional bounded API.</p></noscript>
        <p id="csv-status" role="status" aria-live="polite">Choose a source file. Add an exported file and exact key column to compare.</p>
        <p><button id="csv-download" type="button" hidden>Download JSON report</button></p>
        <pre id="csv-result" tabindex="0" aria-label="CSV diagnostic report"></pre>
        <h2>How to read the report</h2>
        <p>All spans are zero-based half-open byte offsets [start,end). SHA-256 covers every original byte, including a leading BOM and exact line endings. Quoted fields expose both raw spans and logical Unicode code points.</p>
        <p>Comparison matches exact header names and exact logical keys. Duplicate keys are reported as ambiguous; rows are never paired by guesswork. NFC-only differences are warnings, never automatic corrections. Ragged rows can make a comparison incomplete.</p>
        <p>Limits per file: 65,536 bytes, 512 records including the header, 64 fields per record. Output is capped at 1 MiB; large detailed reports may be refused. UTF-8 only; comma separator, double quotes, doubled-quote escapes, CRLF/LF/CR or EOF terminators.</p>
        <p>Reports contain CSV cell text: treat them as sensitively as the input. Closing or clearing this tab discards the tool's in-memory result. The site may have its normal page analytics, but this tool does not send file contents, names or reports to analytics or storage.</p>
        <p><a href="${CSV_WITNESS_PATH}.md">Markdown guide</a> · <a href="${CSV_WITNESS_API}" rel="nofollow">JSON contract</a> · <a href="/api">API guide</a></p>
      </article>`,
  });
}

export function csvWitnessMarkdown(origin: string): string {
  return `# CSV Byte Witness\n\n${CSV_WITNESS_NOTE}\n\n` +
    `- Local tool: ${origin}${CSV_WITNESS_PATH}\n- JSON contract: ${origin}${CSV_WITNESS_API}\n` +
    '- Local processing: select original files; no file upload, persistent storage or outbound request is made by the tool. Reports contain input cell text.\n' +
    '- Limits per file: 65,536 bytes, 512 records including the header, 64 fields per record; maximum report 1,048,576 bytes.\n' +
    '- UTF-8 only, optional leading BOM; comma separator, double-quoted fields and doubled quotes; CRLF, LF, CR and EOF are distinct. No trimming, repair, normalization or formula execution.\n' +
    '- Spans: zero-based half-open byte offsets [start,end); SHA-256 hashes original bytes. NFC collisions are warnings only.\n' +
    '- Compare by an exact header name and exact logical keys. Missing/extra/duplicate keys, ambiguous rows, cell differences and terminators are reported; comparisonComplete is false if matching is ambiguous or row widths differ.\n\n' +
    '## Optional stateless API\n\nPOST /v1/tools/csv-witness with Content-Type: application/json. No authentication required; supplied bytes are processed in memory and never stored by this endpoint. Responses use Cache-Control: no-store.\n\n' +
    'The existing 16,384-byte JSON request-body limit includes base64 and JSON overhead, across both inputs combined. It is enforced while streaming, before JSON parsing. Use the local browser tool for larger files (up to 64 KiB each). Do not send sensitive files to a remote API without your own authorization.\n\n' +
    'Inspect example (the bytes of id\\n1\\n):\n\n```json\n{"mode":"inspect","source_base64":"aWQKMQo="}\n```\n\n' +
    'Use standard canonical padded base64 of the actual bytes (not a data: URL or a file path); empty input is an empty string. Whitespace and noncanonical pad bits are rejected.\n\n' +
    'Compare fields: {"mode":"compare","source_base64":"...","exported_base64":"...","key_column":"id"}. Unknown fields are rejected. No user-supplied hash provider, fetch URL, output-limit override or CSV dialect is accepted by the API.\n\n' +
    'Errors: 400 for invalid JSON/schema/base64; 415 for unsupported MIME; 413 for oversized request; 422 invalid_csv with csv_code and optional byte_offset/side, without input text. UTF-8/quote/input/row/field/output failures are diagnostic refusals; no partial report or repaired data is returned.\n';
}
