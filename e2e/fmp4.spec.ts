import { test, expect } from './fixtures';
import {
  uploadSource,
  runExport,
  selectFmp4Container,
  selectRendition,
  downloadZip,
  listZipEntries,
  readZipEntryText,
  supportsAbrFmp4,
} from './helpers';

test('produces HLS-on-fMP4 output (init segments + .m4s fragments) when selected', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page, () => selectFmp4Container(page));
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('master.m3u8');
  expect(entries).toContain('init_video.mp4');
  expect(entries).toContain('init_audio.mp4');
  expect(entries.some((e) => /^frag_video_\d+\.m4s$/.test(e))).toBe(true);
  expect(entries.some((e) => /^frag_audio_\d+\.m4s$/.test(e))).toBe(true);

  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('AUDIO="aud"');

  const videoPlaylist = readZipEntryText(zipPath, 'video.m3u8');
  expect(videoPlaylist).toContain('#EXT-X-MAP:URI="init_video.mp4"');

  // Same init segments/fragments, described a second way — a DASH manifest
  // referencing them alongside the HLS playlists above (see dash.ts).
  expect(entries).toContain('manifest.mpd');
  const manifest = readZipEntryText(zipPath, 'manifest.mpd');
  expect(manifest).toContain('<AdaptationSet mimeType="video/mp4"');
  expect(manifest).toContain('<AdaptationSet mimeType="audio/mp4"');
  expect(manifest).toContain('initialization="init_video.mp4"');
});

test('previews the exported fMP4 output via a real DASH manifest, not HLS', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page, () => selectFmp4Container(page));
  expect(result).toBe('done');

  await page.click('.export-modal-close');

  // Player.tsx labels itself by which manifest it's actually loaded —
  // real proof this went through the DASH code path (manifest.mpd, read
  // straight from the output folder) rather than silently falling back
  // to the HLS live-preview flow every other output mode uses.
  await expect(page.getByText('DASH result')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('HLS result')).toHaveCount(0);

  const video = page.locator('.player-frame video');
  await expect(video).toHaveJSProperty('readyState', 4, { timeout: 10_000 });
});

test('encodes an adaptive-bitrate rendition as fMP4/DASH (init segments + .m4s fragments), not MPEG-TS', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  // sample.mp4 is 240p — the ABR ladder's lowest rung — so this is the
  // only chip RenditionChips won't disable as an upscale. Still real
  // end-to-end coverage of the ABR+fMP4 pipeline (WebCodecs encode →
  // fragment writer → multi-rendition master + DASH manifest); genuinely
  // exercising more than one rendition at once would need a taller fixture
  // than any this project currently has.
  await selectRendition(page, '240p');

  // Adaptive fMP4/DASH has no FFmpeg fallback (see runAdaptiveHls's own doc
  // comment) — a real product limitation, not a bug, so an environment
  // without hardware WebCodecs H.264 encode genuinely can't produce this
  // output. Skip rather than assert an outcome the app was never going to
  // reach here.
  test.skip(!(await supportsAbrFmp4(page)), 'Adaptive fMP4/DASH needs WebCodecs hardware H.264 encode, unavailable in this environment');

  const result = await runExport(page, () => selectFmp4Container(page));
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  expect(entries).toContain('master.m3u8');
  expect(entries).toContain('init_video_240p.mp4');
  expect(entries).toContain('init_audio.mp4');
  expect(entries.some((e) => /^frag_video_240p_\d+\.m4s$/.test(e))).toBe(true);
  expect(entries.some((e) => /^frag_audio_\d+\.m4s$/.test(e))).toBe(true);
  // No '.ts' segments anywhere — confirms this went through the fMP4 ABR
  // path, not a silent fallback to the MPEG-TS one.
  expect(entries.some((e) => e.endsWith('.ts'))).toBe(false);

  const master = readZipEntryText(zipPath, 'master.m3u8');
  expect(master).toContain('#EXT-X-STREAM-INF');
  expect(master).toContain('AUDIO="aud"');
  expect(master).toContain('video_240p.m3u8');

  const videoPlaylist = readZipEntryText(zipPath, 'video_240p.m3u8');
  expect(videoPlaylist).toContain('#EXT-X-MAP:URI="init_video_240p.mp4"');

  expect(entries).toContain('manifest.mpd');
  const manifest = readZipEntryText(zipPath, 'manifest.mpd');
  expect(manifest).toContain('<AdaptationSet mimeType="video/mp4"');
  expect(manifest).toContain('<AdaptationSet mimeType="audio/mp4"');
  expect(manifest).toContain('initialization="init_video_240p.mp4"');

  // Real Shaka playback through that same manifest — same proof as the
  // single-quality DASH test above, now for the ABR-produced one.
  await page.click('.export-modal-close');
  await expect(page.getByText('DASH result')).toBeVisible({ timeout: 10_000 });
  const video = page.locator('.player-frame video');
  await expect(video).toHaveJSProperty('readyState', 4, { timeout: 10_000 });
});
