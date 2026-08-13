import { test, expect } from './fixtures';
import { uploadSource, addChapter, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('a dropped chapter warns via a hover/click popup, not just an inert badge', async ({ page }) => {
  // The bug this covers: the old warning was a bare span with a native
  // `title` — hover-only, no click/touch equivalent, and no visible affordance
  // that there even was more detail to see.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s

  const track = page.locator('.timeline-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('.timeline-track not found');

  // Place a chapter near the end (~1.9s), then split at 1.6s and delete the
  // second segment — the chapter now falls outside the edit.
  await track.click({ position: { x: box.width * 0.95, y: box.height / 2 } });
  await addChapter(page, 'Near end');
  await track.click({ position: { x: box.width * 0.8, y: box.height / 2 } });
  await page.click('.timeline-toolbar .icon-btn');
  const clips = page.locator('.timeline-clip:not(.timeline-clip--extra)');
  await expect(clips).toHaveCount(2);
  await clips.nth(1).click();
  await clips.nth(1).locator('.timeline-clip-delete').click();
  await expect(clips).toHaveCount(1);

  const warning = page.locator('.chapter-ruler .track-warning');
  await expect(warning).toBeVisible();
  await expect(warning.locator('.track-warning-trigger')).toHaveText('⚠ 1');

  const popup = warning.locator('.track-warning-popup');
  await expect(popup).toBeHidden();

  await warning.hover();
  await expect(popup).toBeVisible();
  await expect(popup).toHaveText('1 chapter(s) fall outside the current edit and will be dropped at export');

  await page.mouse.move(0, 0);
  await expect(popup).toBeHidden();

  // Click toggles it open and keeps it open even after the mouse leaves —
  // the part a native `title` tooltip could never do.
  await warning.locator('.track-warning-trigger').click();
  await expect(popup).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(popup).toBeVisible();

  // An outside click closes it again.
  await page.click('.timeline-toolbar .section-label');
  await expect(popup).toBeHidden();
});

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
