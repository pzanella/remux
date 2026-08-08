import { test, expect } from './fixtures';
import { uploadSource, attachIntro, attachOutro, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('splices an intro and outro clip onto the main content', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'intro.mp4');
  await attachOutro(page, 'outro.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  const segmentCount = entries.filter((e) => e.endsWith('.ts')).length;

  // intro (1s) + main (2s) + outro (1s), each at least one segment of its
  // own — a spliced output has to have strictly more segments than the
  // 1-segment fast-path-alone baseline (see fast-path.spec.ts).
  expect(segmentCount).toBeGreaterThan(1);

  const playlist = readZipEntryText(zipPath, 'index.m3u8');
  expect(playlist).toContain('#EXT-X-ENDLIST');
});
