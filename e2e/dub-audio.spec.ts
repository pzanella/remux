import { test, expect } from './fixtures';
import { uploadSource, attachDubAudio, runExport, downloadZip, listZipEntries, readZipEntryText, totalPlaylistDurationSec } from './helpers';

test('attaches a dub-audio track and emits a master playlist with both audio tracks', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachDubAudio(page, 'dub-audio.m4a');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  // The source's own audio becomes the shared "Original" track (see
  // buildAudioOnlyRenditions) rather than being embedded per-rendition,
  // sitting alongside the dub as a second #EXT-X-MEDIA entry.
  expect(entries).toContain('audio_orig.m3u8');
  expect(entries).toContain('dub_en.m3u8');
  expect(entries.some((e) => /^audio_orig_\d+\.ts$/.test(e))).toBe(true);
  expect(entries.some((e) => /^dub_en_\d+\.ts$/.test(e))).toBe(true);

  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('URI="audio_orig.m3u8"');
  expect(master).toContain('URI="dub_en.m3u8"');
  expect(master).toContain('NAME="dub-audio"');
  expect((master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) ?? []).length).toBe(2);
});

test('a dub track much longer than the main content is cut to match it, not left as one giant trailing segment', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  // long-sample.mp4 is a 180s *video* file — dub-audio only ever reads its
  // audio track (see MediaExtrasPanel's own DUB_AUDIO_ACCEPT comment), and
  // being 178s longer than the main content, this is squarely the "much
  // longer" case, not the small-rounding-sliver one.
  await attachDubAudio(page, 'long-sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('dub_en.m3u8');

  const mainPlaylist = readZipEntryText(zipPath, 'audio_orig.m3u8');
  const dubPlaylist = readZipEntryText(zipPath, 'dub_en.m3u8');
  const mainDuration = totalPlaylistDurationSec(mainPlaylist);
  const dubDuration = totalPlaylistDurationSec(dubPlaylist);

  expect(mainDuration).toBeCloseTo(2, 0);
  // Cut to match the main content (plus a small trailing-tolerance sliver),
  // not anywhere near the dub source's own real 180s length.
  expect(dubDuration).toBeLessThan(mainDuration + 1);

  // The actual symptom this is fixing: a duration-mismatched audio
  // rendition group made real Shaka Player error out (HLS_INVALID_
  // PLAYLIST_HIERARCHY) instead of just playing. Load the real output and
  // confirm it does.
  await page.click('.export-modal-close');
  await expect(page.locator('.player-error')).toHaveCount(0);
  const video = page.locator('.player-frame video');
  // WebKit buffers noticeably slower than Chromium in this whole suite
  // (other specs' own WebKit runs take 2x+ as long) — a generous timeout
  // here, not a loosened bar: readyState 4 (HAVE_ENOUGH_DATA) is still what
  // proves Shaka actually played through cleanly, not just started.
  await expect(video).toHaveJSProperty('readyState', 4, { timeout: 25_000 });
});
