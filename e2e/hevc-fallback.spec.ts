import { test, expect } from './fixtures';
import { uploadSource, runExport, getLogText, downloadZip, listZipEntries } from './helpers';

// Regression test for a silent-corruption bug (fixed in wasm/src/lib.rs +
// src/worker/remux.worker.ts): a native-extension source whose video track
// is actually HEVC (e.g. an iPhone's "High Efficiency" mode) used to sail
// through the fast remux path unexamined, reporting success on an
// undecodable segment. It must now be detected and converted with FFmpeg
// first, the same as any non-native container.
test('detects an HEVC video track and converts with FFmpeg instead of failing or corrupting output', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'hevc-sample.mov');

  const result = await runExport(page);
  expect(result).toBe('done');

  const log = await getLogText(page);
  expect(log).toContain('Converting to H.264');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('index.m3u8');
  expect(entries.some((e) => e.endsWith('.ts'))).toBe(true);
});
