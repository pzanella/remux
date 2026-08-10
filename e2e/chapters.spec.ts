import { test, expect } from './fixtures';
import { uploadSource, addChapter, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('marks a chapter while editing and emits a chapters.vtt with the real title/timing', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await addChapter(page, 'Cold Open');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('chapters.vtt');

  const vtt = readZipEntryText(zipPath, 'chapters.vtt');
  expect(vtt).toContain('WEBVTT');
  expect(vtt).toContain('Cold Open');
  // sample.mp4 is 2s; the one chapter was placed at the playhead's default
  // 0, so its cue spans the whole clip.
  expect(vtt).toContain('00:00:00.000 --> 00:00:02.000');
});

test('shows the real chapter title in Shaka Player\'s native Chapters menu', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await addChapter(page, 'Cold Open');

  const result = await runExport(page);
  expect(result).toBe('done');
  await page.click('.export-modal-close');

  const seekBar = page.locator('.shaka-seek-bar-container, .shaka-seek-bar').first();
  await seekBar.waitFor({ timeout: 10_000 });

  // Player.tsx's loadChaptersTrackWithRetry can take a few seconds to land
  // (chapters.vtt is written early in the worker, but the player only
  // starts retrying once its own load() resolves) — poll the overflow menu
  // for the Chapters entry rather than assuming the first open already has
  // it.
  const overflowButton = page.locator('.shaka-overflow-menu-button');
  const chapterButton = page.locator('.shaka-chapter-button');
  let found = false;
  for (let attempt = 0; attempt < 10 && !found; attempt++) {
    await overflowButton.click();
    found = await chapterButton.isVisible().catch(() => false);
    if (!found) {
      await overflowButton.click(); // close the menu before the next poll
      await page.waitForTimeout(1_500);
    }
  }
  expect(found).toBe(true);

  await chapterButton.click();
  const chapterItem = page.locator('.shaka-chapter-item', { hasText: 'Cold Open' });
  await expect(chapterItem).toBeVisible();
});
