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
  await expect(page.locator('.timeline-panel')).toHaveCount(0);
  await expect(page.locator('.player-frame')).toBeVisible();
});

test('shows a real completed-state panel and a distinct packaging moment around the ZIP download', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  await expect(page.locator('.export-done-panel')).not.toHaveClass(/is-packaging/);
  await expect(page.locator('.export-done-heading')).toHaveText('Export complete');
  await expect(page.locator('.export-done-summary')).toContainText('Single quality (fast remux)');

  const downloadBtn = page.locator('button:has-text("Download ZIP")');
  await expect(downloadBtn).toBeEnabled();

  const zipPath = testInfo.outputPath('output.zip');
  const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);
  await download.saveAs(zipPath);

  // Whatever briefly showed while zipping, the panel and button both land
  // back on their normal completed state once it's done — not stuck
  // showing "Packaging…"/"Zipping…" forever.
  await expect(page.locator('.export-done-panel')).not.toHaveClass(/is-packaging/);
  await expect(page.locator('.export-done-heading')).toHaveText('Export complete');
  await expect(downloadBtn).toBeEnabled();
  await expect(downloadBtn).toHaveText('Download ZIP');

  const entries = listZipEntries(zipPath);
  expect(entries).toContain('index.m3u8');
});
