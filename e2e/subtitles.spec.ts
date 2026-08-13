import { test, expect } from './fixtures';
import { uploadSource, attachSubtitle, splitTimelineAt, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('a dropped cue warns via the same shared track-warning popup CaptionLane uses', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await attachSubtitle(page, 'subtitle.vtt'); // "Hello" 0-1s, "World" 1-2s

  // Split at 0.5s and delete the second segment — neither cue fits entirely
  // within what's left (0-0.5s), so both are dropped.
  await splitTimelineAt(page, 0.25);
  const clips = page.locator('.timeline-clip:not(.timeline-clip--extra)');
  await expect(clips).toHaveCount(2);
  await clips.nth(1).click();
  await clips.nth(1).locator('.timeline-clip-delete').click();
  await expect(clips).toHaveCount(1);

  const warning = page.locator('.caption-track-row .track-warning');
  await expect(warning.locator('.track-warning-trigger')).toHaveText('⚠ 2');
  await warning.hover();
  await expect(warning.locator('.track-warning-popup')).toHaveText('2 cue(s) fall outside the current edit and will be dropped at export');
});

test('attaches a subtitle track and emits a master playlist referencing it', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachSubtitle(page, 'subtitle.vtt');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  // Subtitles only have meaning inside a multivariant playlist, so the
  // worker emits master.m3u8 even on the fast path once a subtitle track
  // is attached (see resolveSubtitleTracks in remux.worker.ts).
  expect(entries).toContain('master.m3u8');
  expect(entries.some((e) => e.endsWith('.vtt'))).toBe(true);

  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('TYPE=SUBTITLES');
});
