import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetDb } from './helpers';
import { compareCsv, LIMITS, type Span } from '../src/tools/byte_witness.mjs';
import { MAX_BODY_BYTES } from '../src/http';

beforeEach(resetDb);
const path = '/v1/tools/csv-witness';
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const page = (url: string, headers: Record<string, string> = {}) =>
  (exports as any).default.fetch(new Request(`https://api.test${url}`, { headers })) as Promise<Response>;

describe('CSV Byte Witness public contract', () => {
  it('keeps typed column differences bound to their original header byte spans', async () => {
    const result = await compareCsv(new TextEncoder().encode('id,old\n1,x\n'), new TextEncoder().encode('id,new\n1,y\n'), 'id');
    const missing: { name: string; headerSpan: Span } = result.columns.missing[0];
    const extra: { name: string; headerSpan: Span } = result.columns.extra[0];
    expect(missing).toEqual({ name: 'old', headerSpan: [3, 6] });
    expect(extra).toEqual({ name: 'new', headerSpan: [3, 6] });
  });
  it('links HTML, Markdown and JSON and serves same-origin module assets under CSP', async () => {
    const html = await page('/tools/csv-witness');
    const text = await html.text();
    expect(html.status).toBe(200);
    expect(text).toContain('href="https://api.test/tools/csv-witness.md"');
    expect(text).toContain('href="https://api.test/v1/tools/csv-witness"');
    expect(text).toContain('type="module" src="/assets/csv-witness.js?v=');
    expect(text).toContain('No account or upload is needed');
    expect(html.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    const markdown = await page('/tools/csv-witness.md');
    expect(markdown.status).toBe(200);
    expect(await markdown.text()).toContain('16,384-byte JSON request-body limit');
    const negotiated = await page('/tools/csv-witness', { accept: 'text/markdown' });
    expect(negotiated.headers.get('content-type')).toContain('text/markdown');
    const contract = await api(path);
    expect(contract.body.limits).toEqual({ ...LIMITS, apiJsonBodyBytes: MAX_BODY_BYTES });
    expect(contract.body.privacy).toEqual({ persistence: false, outboundFetches: false, fileUploadsInBrowser: false });
    for (const asset of ['csv-witness.js', 'byte-witness.mjs']) {
      const r = await page(`/assets/${asset}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/javascript');
    }
    const js = await (await page('/assets/csv-witness.js')).text();
    expect(js).toContain("from './byte-witness.mjs'");
    expect(js).not.toMatch(/\bfetch\s*\(|\blocalStorage\s*\.|\bindexedDB\s*\.|\.innerHTML\s*=/);
  });

  it('preserves BOM, quoting, Unicode and byte spans in the Worker runtime', async () => {
    const input = '\uFEFFid,name\r\n1,"é"\n';
    const result = await api(path, { body: { mode: 'inspect', source_base64: b64(input) } });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
    expect(result.body.encoding.bomSpan).toEqual([0, 3]);
    expect(result.body.records[1].fields[1]).toMatchObject({ rawSpan: [14, 18], logicalText: 'é', logicalCodePoints: ['U+00E9'], logicalCodePointSpans: [[15, 17]] });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    expect(result.body.sha256).toBe([...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join(''));
  });

  it('compares exact keys and retains normalization-only differences and ambiguous duplicates', async () => {
    const result = await api(path, { body: { mode: 'compare', key_column: 'id',
      source_base64: b64('id,name\n1,é\n2,x\n2,y\n3,z\n'), exported_base64: b64('id,name\n1,e\u0301\n2,x\n4,w\n') } });
    expect(result.status).toBe(200);
    expect(result.body.comparisonComplete).toBe(false);
    expect(result.body.summary.normalizationOnlyDifferences).toBe(1);
    expect(result.body.summary.ambiguousKeys).toBe(1);
    expect(result.body.summary.missingMultiplicity).toBe(2);
    expect(result.body.summary.extraMultiplicity).toBe(1);
  });

  it('rejects noncanonical base64, data URLs, unexpected fields and invalid key schemas', async () => {
    for (const value of ['YQ', 'YQ=','YQ==\n', 'YR==', 'data:text/csv;base64,YQ==', ['YQ=='], null]) {
      const r = await api(path, { body: { mode: 'inspect', source_base64: value } });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('invalid_csv_base64');
    }
    expect((await api(path, { body: { mode: 'inspect', source_base64: '', key_column: 'id' } })).body.error.code).toBe('unknown_csv_field');
    expect((await api(path, { body: { mode: 'inspect', source_base64: '', url: 'https://example.org/private' } })).body.error.code).toBe('unknown_csv_field');
    expect((await api(path, { body: { mode: 'compare', source_base64: '', exported_base64: '', key_column: 1 } })).body.error.code).toBe('invalid_csv_key_column');
    expect((await api(path, { body: { mode: 'repair', source_base64: '' } })).body.error.code).toBe('invalid_csv_mode');
  });

  it('rejects MIME/JSON errors and handles empty original bytes without inventing records', async () => {
    const mime = await api(path, { raw: '{}', method: 'POST', headers: { 'content-type': 'text/plain' } });
    expect(mime.status).toBe(415);
    expect((await api(path, { raw: '{', method: 'POST', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const empty = await api(path, { body: { mode: 'inspect', source_base64: '' } });
    expect(empty.status).toBe(200); expect(empty.body.records).toEqual([]);
  });

  it('caps a chunked stream before JSON parsing, without Content-Length', async () => {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096).fill(32)); },
      cancel() { cancelled = true; },
    });
    const r = await (exports as any).default.fetch(new Request(`https://api.test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatchObject({ code: 'request_body_too_large', max_bytes: MAX_BODY_BYTES });
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(6);
  });

  it('returns only fixed error codes/offsets, never uploaded text or logs', async () => {
    const log = vi.spyOn(console, 'error');
    try {
      const secret = 'private-fixture-do-not-echo';
      const quote = await api(path, { body: { mode: 'inspect', source_base64: b64(`"${secret}`) } });
      expect(quote.status).toBe(422);
      expect(quote.body.error).toMatchObject({ code: 'invalid_csv', csv_code: 'UNTERMINATED_QUOTE' });
      expect(JSON.stringify(quote.body)).not.toContain(secret);
      const utf8 = await api(path, { body: { mode: 'inspect', source_base64: '/w==' } });
      expect(utf8.status).toBe(422);
      expect(utf8.body.error).toMatchObject({ csv_code: 'INVALID_UTF8', byte_offset: 0 });
      expect(log).not.toHaveBeenCalled();
      expect((await env.DB.prepare('SELECT count(*) AS n FROM posts').first<{ n: number }>())?.n).toBe(0);
    } finally { log.mockRestore(); }
  });

  it('discovers the tool in agent docs and OpenAPI, and preserves HEAD behavior', async () => {
    expect(await (await page('/llms.txt')).text()).toContain('/tools/csv-witness');
    const spec = await (await page('/openapi.json')).json() as any;
    expect(spec.paths[path].get).toBeDefined(); expect(spec.paths[path].post).toBeDefined();
    const head = await (exports as any).default.fetch(new Request(`https://api.test${path}`, { method: 'HEAD' }));
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
});
