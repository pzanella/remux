import { test, expect } from './fixtures';
import { uploadSource, downloadZip, listZipEntries, readZipEntryText } from './helpers';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

test('pauses mid-job and resumes to a complete, correctly-ordered output', async ({ page }, testInfo) => {
  await page.goto('/');
  // A 180s source (30 segments at the fast path's 6s target duration) —
  // every other fixture in this suite is 1-2s, over before a Pause click
  // could ever land mid-job. The Rust remuxer is fast enough (no
  // re-encoding) that even this only leaves a few hundred ms of real wall
  // time with the Pause button up; there's no slower, smaller substitute
  // without an artificial delay in production code, which isn't worth
  // adding just to make this test easier to hit.
  await uploadSource(page, 'long-sample.mp4');

  await page.click('.btn-export');
  await page.waitForSelector('button:has-text("Start conversion")', { timeout: 5_000 });
  await page.click('button:has-text("Start conversion")');

  // Wait for at least one segment to actually finish before pausing —
  // canResume needs session.lastSegmentIndex >= 0 (see useTranscoder), so
  // pausing before segment 0 completes would leave the UI stuck with
  // neither Resume nor Start available (status is 'paused', not 'idle').
  // The Pause button itself appears the instant the job starts running,
  // well before that, so it's not a usable wait condition on its own.
  await page.locator('.panel-hint').filter({ hasText: /^[1-9]\d* \/ \d+/ }).first().waitFor({ timeout: 10_000 });
  await page.click('button:has-text("Pause")', { timeout: 5_000 });

  // Resume only ever appears once the worker's own PAUSED event has landed
  // and at least one segment is already on disk (see useTranscoder's
  // canResume) — the real, meaningful "we're genuinely paused" signal,
  // not a fixed sleep.
  await page.waitForSelector('button:has-text("Resume")', { timeout: 10_000 });
  await page.click('button:has-text("Resume")');

  await page.waitForSelector('text=Done — your HLS output is ready.', { timeout: 30_000 });

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);

  const segments = entries.filter((e) => /^segment_\d+\.ts$/.test(e)).sort();
  // A truncated resume (restarting from segment 0, or dropping the tail)
  // would produce far fewer than the ~30 segments 180s of content at a 6s
  // target duration implies — not pinned to an exact count, since that's
  // the segmenter's own boundary math, not what this test is checking.
  expect(segments.length).toBeGreaterThan(10);

  const playlist = readZipEntryText(zipPath, 'index.m3u8');
  expect(playlist).toContain('#EXT-X-ENDLIST');
  expect((playlist.match(/#EXTINF/g) ?? []).length).toBe(segments.length);

  // Real decode, not just "the app said done": concatenate every segment
  // in playlist order, remux to a single .mp4 (ffprobe's own concat demuxer
  // reports duration as "N/A" straight off raw MPEG-TS segments — remuxing
  // first gets a container that reliably reports one), and confirm ffmpeg
  // reads the whole ~180s with no errors — the strongest check that
  // pause/resume didn't corrupt, duplicate, or reorder anything across the
  // two worker instances involved (the paused one and the one RESUME
  // spawned).
  const unzipDir = testInfo.outputPath('unzipped');
  execFileSync('unzip', ['-o', zipPath, '-d', unzipDir]);
  const concatListPath = path.join(unzipDir, 'concat.txt');
  fs.writeFileSync(concatListPath, segments.map((s) => `file '${s}'`).join('\n'));
  const joinedPath = path.join(unzipDir, 'joined.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-y', joinedPath]);
  // ffmpeg writes at -v warning to stderr, not stdout — spawnSync (unlike
  // execFileSync, which only ever returns stdout) captures both.
  const decode = spawnSync('ffmpeg', ['-v', 'warning', '-i', joinedPath, '-f', 'null', '-'], { encoding: 'utf-8' });
  expect(decode.stderr.trim()).toBe('');
  const probeOut = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', joinedPath], { encoding: 'utf-8' });
  expect(parseFloat(probeOut.trim())).toBeGreaterThan(175);
});
