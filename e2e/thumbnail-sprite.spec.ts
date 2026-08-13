import { test, expect } from './fixtures';
import { uploadSource, runExport, downloadZip, listZipEntries, readZipEntryText, getLogText } from './helpers';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('generates a scrubbing-preview thumbnail sprite + WebVTT storyboard', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  // generateThumbnailSprite runs fire-and-forget in the worker (see its own
  // comment in remux.worker.ts) so the main export's own "done" doesn't
  // guarantee it's finished yet, especially for a source this fast to
  // remux — give the background FFmpeg pass (its own cold core load
  // included) a real moment before downloading, rather than assuming the
  // very first check already has it. A retry-download loop would be the
  // more principled wait, but re-clicking "Download ZIP" while the first
  // click's own download is still in flight doesn't reliably produce a
  // second 'download' event in this app, so a single generous wait is both
  // simpler and faster here.
  await page.waitForTimeout(8_000);

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('thumbnails.jpg');
  expect(entries).toContain('thumbnails.vtt');

  const vtt = readZipEntryText(zipPath, 'thumbnails.vtt');
  expect(vtt).toContain('WEBVTT');
  expect(vtt).toMatch(/-->/);
  // sample.mp4 is 2s, comfortably under the 2s-per-tile floor -- exactly
  // one cue covering the whole clip.
  expect(vtt).toContain('00:00:00.000 --> 00:00:02.000');
  expect(vtt).toContain('thumbnails.jpg#xywh=0,0,160,90');

  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  const spriteInfo = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path.join(unzipDir, 'thumbnails.jpg')], {
    encoding: 'utf-8',
  }).trim();
  expect(spriteInfo).toBe('mjpeg,160,90');
});

test('generates a thumbnail sprite for a longer source without crashing FFmpeg', async ({ page }, testInfo) => {
  // Regression test for a real "Could not generate the scrubbing-preview
  // thumbnail sprite: Error: FFmpeg exited with code -1: Internal error"
  // report: the old implementation piped the *entire* source through one
  // `fps=...,tile=...` filter chain, decoding every frame sequentially —
  // fine for sample.mp4's 2s, but a plausible way to blow ffmpeg.wasm's
  // single-threaded WASM heap on a longer/heavier real source. long-sample.mp4
  // (180s) needs close to the full THUMBNAIL_MAX_TILES=100 tiles, enough to
  // also exercise the current implementation's own per-tile FFmpeg-instance
  // recycling (confirmed empirically to matter: reusing one instance across
  // ~90 sequential extractions crashes with a bare WASM "memory access out
  // of bounds" around the 65th call, independent of any single call's own
  // cost).
  await page.goto('/');
  await uploadSource(page, 'long-sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  // More tiles than sample.mp4's single-tile case means more recycled
  // FFmpeg-instance cold starts (each paying its own core-load cost, even
  // cached) — a longer wait than the short-fixture test's own 8s.
  await page.waitForTimeout(25_000);

  const logText = await getLogText(page);
  expect(logText).not.toContain('Could not generate the scrubbing-preview thumbnail sprite');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('thumbnails.jpg');
  expect(entries).toContain('thumbnails.vtt');

  const vtt = readZipEntryText(zipPath, 'thumbnails.vtt');
  const cueCount = (vtt.match(/-->/g) ?? []).length;
  // 180s of content, capped at THUMBNAIL_MAX_TILES=100 — comfortably more
  // than sample.mp4's single-tile case, a real multi-tile grid.
  expect(cueCount).toBeGreaterThan(50);

  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  const spriteInfo = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path.join(unzipDir, 'thumbnails.jpg')],
    { encoding: 'utf-8' },
  ).trim();
  const [codec, width, height] = spriteInfo.split(',');
  expect(codec).toBe('mjpeg');
  // A real multi-column, multi-row grid, not a single 160x90 tile.
  expect(Number(width)).toBeGreaterThan(160);
  expect(Number(height)).toBeGreaterThan(90);
});

test('shows a real thumbnail preview on seek-bar hover, via Shaka Player\'s own thumbnails track', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');
  await page.click('.export-modal-close');

  const seekBar = page.locator('.shaka-seek-bar-container, .shaka-seek-bar').first();
  await seekBar.waitFor({ timeout: 10_000 });
  const box = await seekBar.boundingBox();
  expect(box).not.toBeNull();

  // Player.tsx's own loadThumbnailsTrackWithRetry can take up to ~18s to
  // pick up the sprite (generateThumbnailSprite runs fire-and-forget in the
  // worker, including its own FFmpeg cold-start — see both functions' own
  // comments) — so the thumbnails track may not even be registered yet on
  // the first hover. Re-hover periodically (a single instant jump doesn't
  // always register as a real hover in headless Chromium either way, so
  // each attempt moves away and back) until the track is ready and a real
  // preview image loads, rather than assuming one hover lands in the
  // narrow window after it's ready.
  const thumbnailImage = page.locator('.shaka-player-ui-thumbnail-image');
  let naturalWidth = 0;
  for (let attempt = 0; attempt < 10 && naturalWidth === 0; attempt++) {
    await page.mouse.move(box!.x, box!.y + box!.height / 2);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 5 });
    await page.waitForTimeout(2_000);
    naturalWidth = await thumbnailImage.evaluate((img: { naturalWidth: number }) => img.naturalWidth).catch(() => 0);
  }
  expect(naturalWidth).toBeGreaterThan(0);
  await expect(thumbnailImage).toHaveAttribute('src', /^blob:/);
});
