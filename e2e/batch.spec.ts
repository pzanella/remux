import { test, expect } from './fixtures';
import { FIXTURES } from './helpers';
import path from 'node:path';

test('drops multiple files into batch mode and converts them all with one shared setup', async ({ page }, testInfo) => {
  await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dropzone')]);
  await chooser.setFiles([path.join(FIXTURES, 'sample.mp4'), path.join(FIXTURES, 'intro.mp4')]);

  await expect(page.getByText('Batch — 2 files')).toBeVisible({ timeout: 10_000 });
  const queuedNames = await page.locator('.batch-item .panel-value').allTextContents();
  expect(queuedNames).toEqual(['sample.mp4', 'intro.mp4']);

  await page.click('button:has-text("Start batch")');
  await page.locator('.panel-hint', { hasText: /\d+ of \d+ done/ }).waitFor({ timeout: 60_000 });

  const statuses = await page.locator('.status-line').allTextContents();
  expect(statuses).toEqual(['Done', 'Done']);

  // Each item gets its own real output, independently downloadable and
  // decodable — not just a UI-level "done" claim.
  const downloadButtons = page.locator('button:has-text("Download ZIP")');
  await expect(downloadButtons).toHaveCount(2);

  const [download] = await Promise.all([page.waitForEvent('download'), downloadButtons.first().click()]);
  const zipPath = testInfo.outputPath('batch-item-0.zip');
  await download.saveAs(zipPath);
  const { execFileSync } = await import('node:child_process');
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8' }).split('\n').filter(Boolean);
  expect(entries).toContain('index.m3u8');
  expect(entries.some((e) => /^segment_\d+\.ts$/.test(e))).toBe(true);
});

test('single file still goes to the normal editor, not batch mode', async ({ page }) => {
  await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dropzone')]);
  await chooser.setFiles(path.join(FIXTURES, 'sample.mp4'));

  await page.waitForSelector('.topbar', { timeout: 10_000 });
  await expect(page.getByText(/^Batch/)).toHaveCount(0);
  await expect(page.locator('.rendition-chips')).toBeVisible();
});
