import { test, expect } from './fixtures';
import {
  uploadSource,
  attachDubAudio,
  attachIntro,
  attachOutro,
  splitTimelineAt,
  selectRendition,
  runExport,
  downloadZip,
  listZipEntries,
  readZipEntryText,
  totalPlaylistDurationSec,
} from './helpers';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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

test('supports a dub-audio track alongside a trimmed and split timeline on the fast path', async ({ page }, testInfo) => {
  // The bug this covers: dub-audio + edited (trimmed/split) segments used to
  // be a hard export-time error — runSegmentedFastPath had no equivalent of
  // buildAudioOnlyRenditions' "split original audio + cut dub tracks to
  // boundaries" step. Now each cut clip's own audio is also split into a
  // parallel "original" rendition (remuxAuxiliaryClip's hasDubAudio flag)
  // and the dub track is cut to the real boundaries that splice produces.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await splitTimelineAt(page, 0.5);
  await expect(page.locator('.timeline-clip:not(.timeline-clip--extra)')).toHaveCount(2);

  await attachDubAudio(page, 'dub-audio.m4a'); // 3s, at least as long as main

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('audio_orig.m3u8');
  expect(entries).toContain('dub_en.m3u8');
  // Two split clips, each producing its own video segment and its own
  // parallel "original audio" segment (see remuxAuxiliaryClip's own
  // `${segmentPrefix}orig_NNNN.ts` naming).
  expect(entries.filter((e) => /^seg\d+_\d{4}\.ts$/.test(e)).length).toBeGreaterThanOrEqual(2);
  expect(entries.filter((e) => /^seg\d+_orig_\d{4}\.ts$/.test(e)).length).toBeGreaterThanOrEqual(2);
  expect(entries.some((e) => /^dub_en_\d+\.ts$/.test(e))).toBe(true);

  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('URI="audio_orig.m3u8"');
  expect(master).toContain('URI="dub_en.m3u8"');

  // Boundary-aligned to the real (edited, spliced) video output, not the
  // whole unedited source or the dub file's own independent length.
  const mainDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'index.m3u8'));
  const origAudioDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'audio_orig.m3u8'));
  const dubDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'dub_en.m3u8'));
  expect(origAudioDuration).toBeCloseTo(mainDuration, 0);
  expect(dubDuration).toBeCloseTo(mainDuration, 0);

  await page.click('.export-modal-close');
  await expect(page.locator('.player-error')).toHaveCount(0);
  const video = page.locator('.player-frame video');
  await expect
    .poll(async () => video.evaluate((v: { readyState: number }) => v.readyState), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
});

test('still blocks dub-audio together with a trimmed/split timeline on an adaptive-bitrate export, with a client-side warning before export time', async ({
  page,
}) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await splitTimelineAt(page, 0.5);
  await attachDubAudio(page, 'dub-audio.m4a');
  await selectRendition(page, '240p');

  await expect(page.locator('.extras-strip-warning')).toBeVisible();

  const result = await runExport(page);
  expect(result).toBe('error');
});

test('supports a dub-audio track alongside an attached intro and outro', async ({ page }, testInfo) => {
  // The bug this covers: dub-audio + intro/outro used to be a hard
  // export-time error ("Dub-audio tracks are not yet supported together
  // with intro/outro"). Per the product spec, the dub content itself only
  // ever covers the *main* content (never intro/outro) — but every
  // rendition in the same #EXT-X-MEDIA group still has to span the video's
  // *whole* spliced duration for HLS to switch renditions mid-playback, so
  // intro/outro's own real audio (extracted separately, see
  // spliceIntroOutro's own hasDubAudio handling) has to fill the flanking
  // gap in both the "Original" and the dub rendition.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await attachIntro(page, 'intro.mp4'); // 1s
  await attachOutro(page, 'outro.mp4'); // 1s
  await attachDubAudio(page, 'dub-audio.m4a'); // 3s, at least as long as main

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('audio_orig.m3u8');
  expect(entries).toContain('dub_en.m3u8');
  // Intro/outro's own audio, extracted separately from their (now
  // audio-silenced) video segments.
  expect(entries).toContain('introaudio_0000.ts');
  expect(entries).toContain('outroaudio_0000.ts');

  // Intro/outro's own video keeps no embedded audio once dub-audio is
  // attached — otherwise a player would hear it twice, once from the
  // video itself and once from the separately-selected audio rendition.
  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  for (const clip of ['intro_0000.ts', 'outro_0000.ts']) {
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(unzipDir, clip)], {
      encoding: 'utf-8',
    });
    expect(streams).not.toContain('audio');
  }

  // Every rendition in the #EXT-X-MEDIA group spans the *whole* spliced
  // video's own duration (intro + main + outro), not just main's — the
  // real requirement this feature exists to satisfy, and the exact
  // mismatch class that made real Shaka Player error out with a too-short
  // rendition before (see the "much longer" test above).
  const videoDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'index.m3u8'));
  expect(videoDuration).toBeCloseTo(4, 0); // 1s intro + 2s main + 1s outro
  const origAudioDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'audio_orig.m3u8'));
  expect(origAudioDuration).toBeCloseTo(videoDuration, 0);
  const dubDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'dub_en.m3u8'));
  // The dub track's own trailing-tolerance rounding (see the "much longer"
  // test above) stacks with intro/outro's own small audio-frame rounding on
  // both flanks here — looser than toBeCloseTo's own tolerance, but still
  // nowhere near the dub source's real independent length, and always at
  // least as long as the video it has to keep pace with.
  expect(dubDuration).toBeGreaterThanOrEqual(videoDuration);
  expect(dubDuration).toBeLessThan(videoDuration + 1.5);

  await page.click('.export-modal-close');
  await expect(page.locator('.player-error')).toHaveCount(0);
  const video = page.locator('.player-frame video');
  await expect
    .poll(async () => video.evaluate((v: { readyState: number }) => v.readyState), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
});

test('supports dub-audio together with both a split timeline and an attached intro/outro', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await splitTimelineAt(page, 0.5);
  await attachIntro(page, 'intro.mp4');
  await attachOutro(page, 'outro.mp4');
  await attachDubAudio(page, 'dub-audio.m4a');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('audio_orig.m3u8');
  expect(entries).toContain('dub_en.m3u8');

  const videoDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'index.m3u8'));
  const origAudioDuration = totalPlaylistDurationSec(readZipEntryText(zipPath, 'audio_orig.m3u8'));
  expect(origAudioDuration).toBeCloseTo(videoDuration, 0);

  await page.click('.export-modal-close');
  await expect(page.locator('.player-error')).toHaveCount(0);
  const video = page.locator('.player-frame video');
  await expect
    .poll(async () => video.evaluate((v: { readyState: number }) => v.readyState), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
});

test('still blocks dub-audio together with an attached intro/outro on an adaptive-bitrate export, with a client-side warning before export time', async ({
  page,
}) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'intro.mp4');
  await attachOutro(page, 'outro.mp4');
  await attachDubAudio(page, 'dub-audio.m4a');
  await selectRendition(page, '240p');

  await expect(page.locator('.extras-strip-warning')).toBeVisible();

  const result = await runExport(page);
  expect(result).toBe('error');
});
