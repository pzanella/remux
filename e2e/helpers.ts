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

/** Attaches a subtitle track via the persistent caption lane below the
 * preview — works whether or not a track is already attached (the "+ Add
 * captions" empty-state input and the "+ Add track" footer input share the
 * same underlying hidden `<input>`). */
export async function attachSubtitle(page: Page, fixtureName: string): Promise<void> {
  await page.locator('.caption-lane input[type="file"]').setInputFiles(path.join(FIXTURES, fixtureName));
}

/** Toggles an adaptive-bitrate rendition chip (e.g. "240p") on. Selecting
 * any chip is what turns adaptive HLS on at all — see RenditionChips. */
export async function selectRendition(page: Page, label: string): Promise<void> {
  await page.locator('.rendition-chips .chip', { hasText: label }).click();
}

/** Opens the export review modal and starts the job, then waits for
 * either a successful completion or a reported error. Returns which. */
export async function runExport(page: Page): Promise<'done' | 'error'> {
  await page.click('.btn-export');
  await page.waitForSelector('button:has-text("Start conversion")', { timeout: 5_000 });
  await page.click('button:has-text("Start conversion")');
  await Promise.race([
    page.waitForSelector('text=Done — your HLS output is ready.', { timeout: 45_000 }),
    page.waitForSelector('.export-modal-error', { timeout: 45_000 }),
  ]);
  return (await page.$('.export-modal-error')) ? 'error' : 'done';
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
