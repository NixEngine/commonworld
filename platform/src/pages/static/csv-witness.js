import { ByteWitnessError, compareCsv, inspectCsv, LIMITS } from './byte-witness.mjs';

// Local-only: no fetch, analytics event, localStorage or IndexedDB path.
const form = document.getElementById('csv-witness-form');
const status = document.getElementById('csv-status');
const output = document.getElementById('csv-result');
const download = document.getElementById('csv-download');
let report = null;
let generation = 0;

async function read(file) {
  if (!file || file.size > LIMITS.maxInputBytes) throw new ByteWitnessError('INPUT_LIMIT');
  return new Uint8Array(await file.arrayBuffer());
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const current = ++generation;
  report = null; output.textContent = ''; download.hidden = true;
  status.textContent = 'Reading and checking bytes locally…';
  try {
    const source = document.getElementById('csv-source').files[0];
    const exported = document.getElementById('csv-exported').files[0];
    const key = document.getElementById('csv-key').value;
    const result = exported ? await compareCsv(await read(source), await read(exported), key) : await inspectCsv(await read(source));
    if (current !== generation) return;
    // The engine's 1 MiB output bound is measured on this compact JSON encoding.
    report = JSON.stringify(result);
    // Text only: file content can never become HTML or an executable spreadsheet.
    output.textContent = report;
    status.textContent = 'Complete. The report is local to this tab; warnings are diagnostics, not repairs.';
    download.hidden = false;
  } catch (error) {
    if (current !== generation) return;
    const message = error instanceof ByteWitnessError ? error.code : 'FILE_READ_FAILED';
    status.textContent = `Cannot produce a report: ${message}. Check the file limits and the Markdown guide.`;
  }
});

document.getElementById('csv-reset').addEventListener('click', () => {
  ++generation; form.reset(); report = null; output.textContent = ''; download.hidden = true;
  status.textContent = 'Files and result cleared from this tool.';
});

download.addEventListener('click', () => {
  if (report === null) return;
  const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'csv-byte-witness.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
