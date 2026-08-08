import { test, expect } from './fixtures';
import { uploadSource, selectRendition, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('encodes an adaptive-bitrate rendition and emits a multivariant playlist', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  // The source fixture is 240p — the ABR ladder's lowest rung — so this is
  // the only chip RenditionChips won't disable as an upscale.
  await selectRendition(page, '240p');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('master.m3u8');
  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('#EXT-X-STREAM-INF');
});
