import { test, expect } from './fixtures';
import { uploadSource, runExport, enableLoudnessNormalization, downloadZip, listZipEntries, FIXTURES } from './helpers';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

test('normalizes quiet audio to the EBU R128 target without touching video', async ({ page }, testInfo) => {
  await page.goto('/');
  // A dedicated fixture, not sample.mp4: its own audio already sits close
  // to -23 LUFS, too small a gap to tell "normalized" apart from "just
  // happened to be close already". quiet-audio.mp4's sine wave is
  // deliberately mixed way down (~-56 LUFS measured) so a real shift is
  // unambiguous.
  await uploadSource(page, 'quiet-audio.mp4');

  const result = await runExport(page, () => enableLoudnessNormalization(page));
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  const segment = entries.find((e) => /^segment_\d+\.ts$/.test(e));
  expect(segment).toBeDefined();

  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  const outputPath = path.join(unzipDir, segment!);

  // Real, independent measurement — not trusting the app's own "done" —
  // via ffmpeg's own loudnorm filter in analysis mode against the actual
  // exported segment. ffmpeg writes its log (including loudnorm's JSON
  // stats) to stderr, not stdout.
  const probe = spawnSync('ffmpeg', ['-i', outputPath, '-af', 'loudnorm=I=-23:TP=-1:LRA=7:print_format=json', '-f', 'null', '-'], { encoding: 'utf-8' });
  const match = probe.stderr.match(/\{[^{}]*\}/g);
  expect(match).not.toBeNull();
  const stats = JSON.parse(match![match!.length - 1]);
  expect(Math.abs(parseFloat(stats.input_i) - -23)).toBeLessThan(1);

  // Loudness normalization only ever touches audio (-c:v copy throughout,
  // see normalizeLoudness in remux.worker.ts) — confirm the video really
  // is untouched by comparing every decoded frame against the source,
  // not just trusting the codec/container didn't change.
  const srcFramesPath = path.join(unzipDir, 'src_frames.md5');
  const outFramesPath = path.join(unzipDir, 'out_frames.md5');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(FIXTURES, 'quiet-audio.mp4'), '-map', '0:v:0', '-f', 'framemd5', '-y', srcFramesPath]);
  execFileSync('ffmpeg', ['-v', 'error', '-i', outputPath, '-map', '0:v:0', '-f', 'framemd5', '-y', outFramesPath]);
  const fs = await import('node:fs');
  const srcFrames = fs.readFileSync(srcFramesPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
  const outFrames = fs.readFileSync(outFramesPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
  expect(outFrames).toEqual(srcFrames);
});
