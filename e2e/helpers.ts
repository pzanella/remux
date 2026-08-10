import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

// `package.json`'s "type": "module" makes this file ESM at runtime even
// though it's type-checked under CommonJS (see e2e/tsconfig.json) — no
// __dirname, so derive the equivalent from import.meta.url instead.
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Drops a source file onto the empty-state dropzone and waits for the
 * editor to load. */
export async function uploadSource(page: Page, fixtureName: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dropzone')]);
  await chooser.setFiles(path.join(FIXTURES, fixtureName));
  await page.waitForSelector('.topbar', { timeout: 30_000 });
}

/** Expands the persistent intro/outro/dub-audio strip if it's collapsed. */
export async function expandExtrasStrip(page: Page): Promise<void> {
  const toggle = page.locator('.extras-strip-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

export async function attachIntro(page: Page, fixtureName: string): Promise<void> {
  await expandExtrasStrip(page);
  await page.locator('.extras-row input[type="file"]').first().setInputFiles(path.join(FIXTURES, fixtureName));
}

export async function attachOutro(page: Page, fixtureName: string): Promise<void> {
  await expandExtrasStrip(page);
  // Intro's file input exists whether or not intro is already attached, so
  // once intro is attached this is the remaining (first) file input.
  await page.locator('.extras-row input[type="file"]').first().setInputFiles(path.join(FIXTURES, fixtureName));
}

/** Attaches a dub-audio track via the persistent intro/outro/dub-audio strip
 * — selected by its own distinct `accept` attribute (see MediaExtrasPanel's
 * `DUB_AUDIO_ACCEPT`) rather than position, since unlike intro/outro this
 * file input never moves regardless of how many dub tracks are already
 * attached. */
export async function attachDubAudio(page: Page, fixtureName: string): Promise<void> {
  await expandExtrasStrip(page);
  await page.locator('.extras-row input[type="file"][accept*=".m4a"]').setInputFiles(path.join(FIXTURES, fixtureName));
}

/** Attaches a subtitle track via the persistent caption lane below the
 * preview — works whether or not a track is already attached (the "+ Add
 * captions" empty-state input and the "+ Add track" footer input share the
 * same underlying hidden `<input>`). */
export async function attachSubtitle(page: Page, fixtureName: string): Promise<void> {
  await page.locator('.caption-lane input[type="file"]').setInputFiles(path.join(FIXTURES, fixtureName));
}

/** Drops a chapter marker at the current playhead (0 by default, since the
 * preview hasn't been scrubbed) via the persistent chapter ruler below the
 * caption lane, then renames it through the inline title input that opens
 * automatically once the marker is selected (see ChapterRuler). */
export async function addChapter(page: Page, title: string): Promise<void> {
  await page.click('.chapter-ruler button:has-text("+ Chapter here")');
  const titleInput = page.locator('.chapter-editor-row .text-input');
  await titleInput.waitFor({ timeout: 5_000 });
  await titleInput.fill(title);
}

/** Toggles an adaptive-bitrate rendition chip (e.g. "240p") on. Selecting
 * any chip is what turns adaptive HLS on at all — see RenditionChips. */
export async function selectRendition(page: Page, label: string): Promise<void> {
  await page.locator('.rendition-chips .chip', { hasText: label }).click();
}

/** Opens the export review modal and starts the job, then waits for
 * either a successful completion or a reported error. Returns which.
 * `beforeStart` runs after the modal is open (so its own output/container
 * controls are visible) but before "Start conversion" is clicked — e.g. for
 * `selectFmp4Container`. */
export async function runExport(page: Page, beforeStart?: () => Promise<void>): Promise<'done' | 'error'> {
  await page.click('.btn-export');
  await page.waitForSelector('button:has-text("Start conversion")', { timeout: 5_000 });
  if (beforeStart) await beforeStart();
  await page.click('button:has-text("Start conversion")');
  await Promise.race([
    page.waitForSelector('text=Done — your HLS output is ready.', { timeout: 45_000 }),
    page.waitForSelector('.export-modal-error', { timeout: 45_000 }),
  ]);
  return (await page.$('.export-modal-error')) ? 'error' : 'done';
}

/** Switches the export review modal's output container to fragmented MP4
 * (default is MPEG-TS) — see `runExport`'s `beforeStart`. */
export async function selectFmp4Container(page: Page): Promise<void> {
  await page.getByLabel('Fragmented MP4 (experimental)').check();
}

/** Enables EBU R128 loudness normalization on the export review screen —
 * see `runExport`'s `beforeStart`. */
export async function enableLoudnessNormalization(page: Page): Promise<void> {
  await page.getByLabel('Normalize loudness (EBU R128)').check();
}

export async function getLogText(page: Page): Promise<string> {
  const logTab = page.locator('.tab-btn', { hasText: 'Log' });
  await logTab.click();
  return page.locator('.log-console').innerText();
}

/** Downloads the export ZIP to `destPath` and returns it. */
export async function downloadZip(page: Page, destPath: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download ZIP")')]);
  await download.saveAs(destPath);
  return destPath;
}

/** Lists entry names inside a ZIP produced by src/lib/zip.ts (a plain
 * STORE-only archive, so the system `unzip` CLI — present on both macOS dev
 * machines and ubuntu-latest GitHub runners — reads it without needing a
 * JS zip library as a project dependency just for tests). */
export function listZipEntries(zipPath: string): string[] {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

export function readZipEntryText(zipPath: string, entryName: string): string {
  return execFileSync('unzip', ['-p', zipPath, entryName], { encoding: 'utf-8' });
}
