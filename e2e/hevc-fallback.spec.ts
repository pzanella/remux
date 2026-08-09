import { test, expect } from './fixtures';
import { uploadSource, runExport, getLogText, downloadZip, listZipEntries, readZipEntryText, FIXTURES } from './helpers';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Regression test for a silent-corruption bug (fixed in wasm/src/lib.rs +
// src/worker/remux.worker.ts): a native-extension source whose video track
// is actually HEVC (e.g. an iPhone's "High Efficiency" mode) used to sail
// through the fast remux path unexamined, reporting success on an
// undecodable segment.
//
// The Rust muxer now understands HEVC natively (see wasm/src/hevc.rs) and
// byte-copies it straight into MPEG-TS the same lossless way it already
// does for AVC — no FFmpeg re-encode needed. Non-native containers and
// unrecognized video codecs (VP9, AV1, ...) still go through the FFmpeg
// fallback; that part of the detection is unit-tested on the Rust side
// (`UNSUPPORTED_VIDEO_CODEC`) and not re-covered here.
test('remuxes an HEVC video track natively into MPEG-TS, without an FFmpeg re-encode', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'hevc-sample.mov');

  const result = await runExport(page);
  expect(result).toBe('done');

  const log = await getLogText(page);
  expect(log).not.toContain('Converting to H.264');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('index.m3u8');
  const segment = entries.find((e) => /^segment_\d+\.ts$/.test(e));
  expect(segment).toBeDefined();

  const playlist = readZipEntryText(zipPath, 'index.m3u8');
  expect(playlist).toContain('#EXT-X-ENDLIST');

  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  const outputPath = path.join(unzipDir, segment!);

  // Real, independent checks — not trusting the app's own "done": the
  // output stream really is HEVC (confirms the PMT's stream_type is 0x24,
  // not silently still 0x1B/AVC), it decodes with zero errors or warnings,
  // and every decoded frame is byte-for-byte identical to the source —
  // exactly the lossless byte-copy this path promises, same as the
  // existing AVC fast path already gets.
  // MPEG-TS demuxing sometimes has ffprobe print the same stream's
  // codec_name more than once (a container/CSV-writer quirk, not a defect
  // in this project's own output) — check what codec was found, not the
  // exact line count.
  const codecNames = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outputPath], {
    encoding: 'utf-8',
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  expect(codecNames.every((c) => c === 'hevc')).toBe(true);
  expect(codecNames.length).toBeGreaterThan(0);

  const decode = spawnSync('ffmpeg', ['-v', 'warning', '-i', outputPath, '-f', 'null', '-'], { encoding: 'utf-8' });
  expect(decode.stderr.trim()).toBe('');

  const srcFramesPath = path.join(unzipDir, 'src_frames.md5');
  const outFramesPath = path.join(unzipDir, 'out_frames.md5');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(FIXTURES, 'hevc-sample.mov'), '-map', '0:v:0', '-f', 'framemd5', '-y', srcFramesPath]);
  execFileSync('ffmpeg', ['-v', 'error', '-i', outputPath, '-map', '0:v:0', '-f', 'framemd5', '-y', outFramesPath]);
  const srcFrames = fs.readFileSync(srcFramesPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
  const outFrames = fs.readFileSync(outFramesPath, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
  expect(outFrames).toEqual(srcFrames);
});

test('rejects HEVC combined with fMP4 output, falling back to FFmpeg conversion instead of producing broken fMP4', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'hevc-sample.mov');

  const result = await runExport(page, async () => {
    await page.getByLabel('Fragmented MP4 (experimental)').check();
  });
  expect(result).toBe('done');

  // fMP4's own sample-entry/config-record writer is still AVC-only (see
  // needsConversionForUnsupportedCodec's own comment) -- this combination
  // must still take the FFmpeg pre-conversion detour, converting the HEVC
  // source to AVC first, unlike the MPEG-TS case above.
  const log = await getLogText(page);
  expect(log).toContain('Converting to H.264');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('init_video.mp4');
  expect(entries.some((e) => /^frag_video_\d+\.m4s$/.test(e))).toBe(true);
});
