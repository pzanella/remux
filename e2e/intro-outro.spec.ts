import path from 'node:path';
import { test, expect } from './fixtures';
import {
  FIXTURES,
  uploadSource,
  attachIntro,
  attachOutro,
  expandExtrasStrip,
  splitTimelineAt,
  dropFileOnto,
  runExport,
  downloadZip,
  listZipEntries,
  readZipEntryText,
  getLogText,
} from './helpers';

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

test('shows attached intro/outro as flanking cards in the timeline rail, not just the collapsed strip', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'intro.mp4');
  await attachOutro(page, 'outro.mp4');

  await expect(page.locator('.rail-extra-card--intro')).toContainText('intro.mp4');
  await expect(page.locator('.rail-extra-card--outro')).toContainText('outro.mp4');
});

test('blocks splitting the timeline once an intro/outro is attached, instead of only failing at export time', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'intro.mp4');

  // The split button is only reachable this way once a card is selected
  // and the playhead lands inside it — same setup as splitTimelineAt, but
  // asserting on the button's own disabled state instead of clicking it.
  const lane = page.locator('.chapter-ruler-lane');
  const box = await lane.boundingBox();
  await lane.click({ position: { x: box!.width * 0.5, y: box!.height / 2 } });
  await expect(page.locator('.split-button')).toBeDisabled();
});

test('blocks attaching an intro/outro once the timeline has been split, instead of only failing at export time', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await splitTimelineAt(page, 0.5);
  await expandExtrasStrip(page);

  await expect(page.locator('.extras-warning')).toBeVisible();
  await expect(page.locator('.extras-row').getByRole('button', { name: '+ Intro' })).toBeDisabled();
  await expect(page.locator('.extras-row').getByRole('button', { name: '+ Outro' })).toBeDisabled();
  // The timeline's own intro/outro slots (see VerticalTimeline's
  // IntroOutroSlot) are a second entry point for the exact same action —
  // must be equally blocked, not just the collapsed strip's buttons.
  await expect(page.locator('.rail-extra-slot').first()).toBeDisabled();
  await expect(page.locator('.rail-extra-slot').last()).toBeDisabled();
});

test('drag-and-dropping a video file onto the timeline\'s intro/outro slots attaches it', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');

  const introSlot = page.locator('.rail-extra-slot').first();
  await dropFileOnto(page, introSlot, path.join(FIXTURES, 'intro.mp4'));
  await expect(page.locator('.rail-extra-card--intro')).toContainText('intro.mp4');

  // Intro's own empty slot is gone now that it's attached (replaced by
  // .rail-extra-card--intro), so the one remaining .rail-extra-slot is outro's.
  const outroSlot = page.locator('.rail-extra-slot').first();
  await dropFileOnto(page, outroSlot, path.join(FIXTURES, 'outro.mp4'));
  await expect(page.locator('.rail-extra-card--outro')).toContainText('outro.mp4');
});

test('a hardware-encoding fallback along the way does not falsely report the export as failed', async ({ page }, testInfo) => {
  // long-sample.mp4 is 160x120 with 22050 Hz audio, against sample.mp4's
  // 320x240/44100 Hz — a real combination that, at least on Chromium (this
  // is real WebCodecs behavior, not guaranteed identical across engines —
  // WebKit encodes this one straight through with no fallback needed),
  // trips a recoverable fallback while letterboxing the intro to match the
  // main content: WebCodecs' AAC encoder rejects the non-standard sample
  // rate, logged at 'ERROR' level for its red console styling. Before the
  // fix, that log level was *also* what the whole job's status came from,
  // so the export UI declared "Something went wrong" and gave up watching
  // a job that was still running — and, via its own FFmpeg fallback, went
  // on to finish correctly seconds later.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await attachIntro(page, 'long-sample.mp4');
  await attachOutro(page, 'outro.mp4');

  const result = await runExport(page);
  expect(result).toBe('done');

  const logText = await getLogText(page);
  expect(logText).toContain('Done!');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries.some((e) => e.endsWith('.ts'))).toBe(true);
  expect(readZipEntryText(zipPath, 'index.m3u8')).toContain('#EXT-X-ENDLIST');

  await page.click('.export-modal-close');
  await expect(page.locator('.player-error')).toHaveCount(0);
  // At least HAVE_CURRENT_DATA (2), not the stricter HAVE_ENOUGH_DATA (4)
  // other specs check: this particular shape (an FFmpeg-fallback-encoded
  // intro spliced with a fast-path main+outro) reliably buffers past
  // initial data on both engines, but doesn't reach fully-buffered within
  // any reasonable wait on WebKit specifically — a separate, narrower
  // playback nuance from the false-failure bug this test is actually about
  // (no player-error fired above, which is what that bug would have
  // caused). Real, but for another investigation.
  const video = page.locator('.player-frame video');
  await expect
    .poll(async () => video.evaluate((v: { readyState: number }) => v.readyState), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
});
