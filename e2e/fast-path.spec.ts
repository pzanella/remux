import { test, expect } from './fixtures';
import { uploadSource, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('converts a native H.264/AAC source via the fast remux path', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('index.m3u8');
  expect(entries.some((e) => e.endsWith('.ts'))).toBe(true);

  const playlist = readZipEntryText(zipPath, 'index.m3u8');
  expect(playlist).toContain('#EXTM3U');
  expect(playlist).toContain('#EXT-X-ENDLIST');

  // The editing rail (timeline, captions, chapters) has nothing left to do
  // once the job is running — it gets out of the way entirely instead of
  // sticking around disabled, leaving the result player as the one focus.
  await page.click('.export-modal-close');
  await expect(page.locator('.timeline-rail-panel')).toHaveCount(0);
  await expect(page.locator('.player-frame')).toBeVisible();
});
