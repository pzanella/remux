import { test, expect } from './fixtures';
import { uploadSource, attachDubAudio, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

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
