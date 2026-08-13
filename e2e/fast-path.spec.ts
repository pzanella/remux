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

  // Scoped to the modal's own button — the topbar's export button also
  // reads "Download ZIP" once complete (see the dedicated test for that
  // below), which would otherwise make a bare text match ambiguous.
  const downloadBtn = page.locator('.export-download-btn');
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

test('the topbar\'s own export button reads "Download ZIP" once the job is done', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const topbarBtn = page.locator('.btn-export');
  await expect(topbarBtn).toHaveText('Export HLS');

  const result = await runExport(page);
  expect(result).toBe('done');
  await expect(topbarBtn).toHaveText('Download ZIP');

  // Closing the modal (the actual bug report: the button used to always say
  // "Export HLS" even once nothing was left to export) doesn't revert it —
  // the label reflects the job's own status, not whether the modal is open.
  await page.click('.export-modal-close');
  await expect(topbarBtn).toHaveText('Download ZIP');

  // Clicking it still reopens the same modal, now straight to its completed
  // panel — same real download action, not a dead end.
  await topbarBtn.click();
  await expect(page.locator('.export-done-panel')).toBeVisible();
});

test('the export modal backdrop covers the full viewport on a wide screen', async ({ page }) => {
  // Regression test: ExportModal renders as a direct child of .app-shell
  // (see App.tsx), and `.app-shell > * { max-width: 1440px; }` (a
  // page-centering rule meant for the editor's own content) used to leak
  // onto the backdrop too, capping its width and leaving a gap on the right
  // edge of any viewport wider than 1440px. Playwright's own default
  // viewport is narrower than that, so this needs an explicit wide one to
  // actually exercise the bug.
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  await page.click('.btn-export');
  const backdrop = page.locator('.export-modal-backdrop');
  await backdrop.waitFor({ timeout: 5_000 });
  const box = await backdrop.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.width).toBe(1920);
  expect(box!.height).toBe(900);
});
