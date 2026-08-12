import { test, expect } from './fixtures';
import { uploadSource, attachIntro, attachOutro, expandExtrasStrip, splitTimelineAt, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

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
  await expect(page.getByRole('button', { name: '+ Intro' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '+ Outro' })).toBeDisabled();
});
