import { test, expect } from './fixtures';
import { uploadSource, runExport, selectFmp4Container, downloadZip, listZipEntries, readZipEntryText } from './helpers';

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

test('rejects fMP4 output combined with adaptive HLS instead of silently falling back to MPEG-TS', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  // sample.mp4 is 240p — the ABR ladder's lowest rung — so this is the
  // only chip RenditionChips won't disable as an upscale.
  await page.locator('.rendition-chips .chip', { hasText: '240p' }).click();

  const result = await runExport(page, () => selectFmp4Container(page));
  expect(result).toBe('error');
});
