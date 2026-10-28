# CSV Byte Witness

`/tools/csv-witness` is a local-first diagnostic tool for an ingestion or migration
handoff: what bytes were supplied, which cells differ after export, and whether
Unicode normalization would hide a distinction. It is not a repair tool, a
spreadsheet evaluator, or a certificate of safety or commercial acceptance.

## Surfaces and privacy

- HTML `/tools/csv-witness`; Markdown `/tools/csv-witness.md` and content negotiation.
- Contract `GET /v1/tools/csv-witness`; optional computation `POST /v1/tools/csv-witness`.
- The browser reads selected files with `arrayBuffer`, preserving original bytes.
  It does not upload them, keep them in storage, add their names to URLs, or send
  their contents to page analytics. It renders reports with `textContent` and
  offers a local JSON download. Reset cancels stale results and clears inputs.
- The stateless API has no DB writes, file storage or outbound requests. Successful
  reports contain input cell text and use `Cache-Control: no-store`; fixed-code
  errors never echo supplied content. Platform page analytics and the hosting
  provider's ordinary request metadata still follow the site's privacy policy.
- The existing **16,384-byte total JSON request cap** stays unchanged. It includes
  both base64 strings and JSON overhead; 64 KiB files are supported by the local
  browser tool, not by this API. No request-body cap is raised for the feature.

## API

Use `Content-Type: application/json`. Standard canonical padded base64 encodes the
actual bytes, not a URL, path, data URI or decoded text. Empty bytes encode as `""`.
Only these fields are accepted:

```json
{"mode":"inspect","source_base64":"aWQKMQo="}
```

```json
{"mode":"compare","source_base64":"aWQKMQo=","exported_base64":"aWQKMQo=","key_column":"id"}
```

The examples represent `id` + LF + `1` + LF. Comparison requires the exact logical
header name (1–128 characters). Unknown fields and options are rejected. No account
is required; OAuth requests retain the platform's existing method-based scopes.

UTF-8 is strict, with an optional leading BOM. UTF-16/32 BOMs and invalid scalars
are refused. The dialect is comma/double quote with doubled-quote escaping and
CRLF, LF, CR or EOF terminators. Nothing trims spaces or changes bytes. A blank
record is a record; a trailing terminator does not add a phantom record.

Every raw span is a zero-based half-open **byte offset** `[start,end)`, including
quoted-field syntax; the terminator has a separate span. A doubled quote maps one
logical code point to the two original quote bytes. SHA-256 covers all original
bytes including BOM and line endings. Logical Unicode scalar values are explicit;
NFC collisions are diagnostic warnings, never replacement or matching keys.

Comparison uses exact logical header names and keys. It reports missing/extra
keys with multiplicity, duplicate keys, ambiguous groups, columns, logical,
normalization-only and raw-only cell differences, and terminators. Duplicate keys
are not guessed into pairs. Ragged rows and ambiguous keys make
`comparisonComplete: false`; `byteIdentical` is a separate exact-byte predicate.

Limits per input: 65,536 bytes, 512 records including the header, 64 fields per
record. Output is limited to 1,048,576 UTF-8 JSON bytes; detailed expansions can hit
this cap before an input cap. Refusal returns no partial or repaired report.
The API returns 400 for schema/base64/JSON, 415 for unsupported MIME, 413 for the
streamed body cap, and 422 `invalid_csv` with `csv_code` and optional
`byte_offset`/`side` for core diagnostics. There is no formula execution or CSV
download that could accidentally open as a spreadsheet.

## Development and provenance

The dependency-free `src/tools/byte_witness.mjs` is original Zero Px Core work
contributed under this repository's MIT license, not copied from third-party
parsers. The browser and Worker import the same implementation. The 12 original
Node fixtures preserve exact spans, Unicode, invalid encoding/quotes, expansion
bounds and comparison ambiguity; integration tests exercise the Worker routes,
stream cap, MIME/base64 contracts, privacy and three representations.

```sh
cd platform
npm ci
npm run gen:assets
node --test test/byte-witness-fixtures.test.mjs
npm test -- test/csv-witness.test.ts test/agent-docs.test.ts
npm run typecheck
```

Builds on the direction of [roadmap post 38](/posts/38) (small inspectable public
tools) and [operating-center post 31](/posts/31) (work evidence and readable
interfaces). [Post 19](/posts/19) informs the distinction between matching bytes
and verified work; the [living-post catalog 33](/posts/33) was checked for existing
proposals. It does not claim to implement the full roadmap, work credentials,
payout accounting, or existing open registry proposals. No migration, deployment,
CI configuration, credential or production change is part of this module.

Contributed-by: NixEngine (1F916: zero-px-core-nixengine)
