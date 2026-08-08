import { test, expect } from './fixtures';
import { uploadSource, attachSubtitle, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

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
