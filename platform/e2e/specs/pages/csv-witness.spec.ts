import { expect, test } from '@playwright/test';

test('inspects original bytes and clears results without transmitting file data', async ({ page }) => {
  const transmitted: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET') transmitted.push(request.postData() ?? request.url());
  });
  await page.goto('/tools/csv-witness');
  await page.locator('#csv-source').setInputFiles({ name: 'private-test.csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFFid,value\r\n1,"<script>alert(1)</script>"\n') });
  await page.getByRole('button', { name: 'Inspect / compare locally' }).click();
  await expect(page.locator('#csv-status')).toContainText('Complete.');
  const result = JSON.parse(await page.locator('#csv-result').innerText());
  expect(result.encoding.bomSpan).toEqual([0, 3]);
  expect(result.records[1].fields[1].logicalText).toBe('<script>alert(1)</script>');
  expect(await page.locator('#csv-result script').count()).toBe(0);
  expect(transmitted.some(value => value.includes('alert(1)') || value.includes('private-test.csv') || value.includes('source_base64'))).toBe(false);
  await expect(page.locator('#csv-download')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#csv-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('csv-byte-witness.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.byteLength).toBeLessThanOrEqual(1_048_576);
  expect(JSON.parse(downloaded.toString('utf8')).sha256).toBe(result.sha256);
  await page.getByRole('button', { name: 'Clear files and result' }).click();
  await expect(page.locator('#csv-result')).toHaveText('');
  await expect(page.locator('#csv-download')).toBeHidden();
});

test('compares normalization-only changes and refuses malformed bytes without echo', async ({ page }) => {
  await page.goto('/tools/csv-witness');
  await page.locator('#csv-source').setInputFiles({ name: 'source.csv', mimeType: 'text/csv', buffer: Buffer.from('id,value\n1,é\n') });
  await page.locator('#csv-exported').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('id,value\n1,e\u0301\n') });
  await page.locator('#csv-key').fill('id');
  await page.getByRole('button', { name: 'Inspect / compare locally' }).click();
  await expect(page.locator('#csv-status')).toContainText('Complete.');
  expect(JSON.parse(await page.locator('#csv-result').innerText()).summary.normalizationOnlyDifferences).toBe(1);
  await page.getByRole('button', { name: 'Clear files and result' }).click();
  await page.locator('#csv-source').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from([255]) });
  await page.getByRole('button', { name: 'Inspect / compare locally' }).click();
  await expect(page.locator('#csv-status')).toContainText('INVALID_UTF8');
  await expect(page.locator('#csv-result')).toHaveText('');
});
