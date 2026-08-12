import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * Simulates a native OS file drop (a real `dragenter`/`dragover`/`drop`
 * sequence with a `DataTransfer` carrying real file bytes) onto `locator` —
 * for drop targets with no backing `<input type="file">` a plain
 * `setInputFiles` could target directly (e.g. VerticalTimeline's own
 * intro/outro slots). The DataTransfer-building callback is passed as a
 * plain string, not a typed function: it references browser-only globals
 * (File, DataTransfer, atob) that e2e/tsconfig.json's DOM-less lib doesn't
 * know about, even though they're real and correct once this actually runs
 * in the browser — same class of gap documented on other DOM-typed e2e
 * helpers in this file.
 */
export async function dropFileOnto(page: Page, locator: Locator, filePath: string): Promise<void> {
  const base64 = readFileSync(filePath).toString('base64');
  const fileName = path.basename(filePath);
  const dataTransfer = await page.evaluateHandle(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(fileName)}, { type: 'video/mp4' });
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  })()`);

  await locator.dispatchEvent('dragenter', { dataTransfer });
  await locator.dispatchEvent('dragover', { dataTransfer });
  await locator.dispatchEvent('drop', { dataTransfer });
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
  // selectIntroFile is async (OPFS write + video-metadata probe) — the
  // input's own change event resolving is not proof the ingest itself (and
  // the resulting re-render that repositions outro's input to `.first()`)
  // has actually landed. Without this wait, a same-tick attachOutro call
  // can race it and land in what's still the *intro* slot (confirmed
  // empirically: manifest.intro.fileName came back as the outro fixture).
  await page.waitForSelector('.extras-item-name:has-text("Intro:")', { timeout: 10_000 });
}

export async function attachOutro(page: Page, fixtureName: string): Promise<void> {
  await expandExtrasStrip(page);
  // Intro's file input exists whether or not intro is already attached, so
  // once intro is attached this is the remaining (first) file input.
  await page.locator('.extras-row input[type="file"]').first().setInputFiles(path.join(FIXTURES, fixtureName));
  await page.waitForSelector('.extras-item-name:has-text("Outro:")', { timeout: 10_000 });
}

/** Attaches a dub-audio track via the persistent intro/outro/dub-audio strip
 * — selected by its own distinct `accept` attribute (see MediaExtrasPanel's
 * `DUB_AUDIO_ACCEPT`) rather than position, since unlike intro/outro this
 * file input never moves regardless of how many dub tracks are already
 * attached. */
export async function attachDubAudio(page: Page, fixtureName: string): Promise<void> {
  await expandExtrasStrip(page);
  const rows = page.locator('.dub-audio-list .extras-row');
  const countBefore = await rows.count();
  await page.locator('.extras-row input[type="file"][accept*=".m4a"]').setInputFiles(path.join(FIXTURES, fixtureName));
  // selectDubAudioTrack is async (video-metadata probe + OPFS write) — the
  // input's own change event resolving isn't proof the track has actually
  // landed in state yet (same class of race `attachIntro`/`attachOutro` hit
  // — see their own comments), which matters here whenever a caller acts on
  // the track immediately after (e.g. saving a project right away).
  await expect(rows).toHaveCount(countBefore + 1, { timeout: 10_000 });
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

/** Splits the timeline at a fractional position (0-1) of the current
 * clip's own duration — scrubs the playhead there via the chapter ruler's
 * own scrub lane (any of the persistent lanes under the preview double as
 * one; this one needs no pre-existing track to already be attached), then
 * clicks the "Split here" button VerticalTimeline shows once the playhead
 * lands inside the selected (by default, the only) segment. */
export async function splitTimelineAt(page: Page, fraction: number): Promise<void> {
  const lane = page.locator('.chapter-ruler-lane');
  const box = await lane.boundingBox();
  if (!box) throw new Error('.chapter-ruler-lane not found — is the editor showing?');
  // A locator click with an explicit position — not a raw `page.mouse.click`
  // at the same viewport coordinates — is what actually reaches the lane's
  // own `onPointerDown` scrub handler reliably (confirmed empirically: the
  // raw mouse API left the playhead at 0% here even though the click itself
  // registered, silently turning every split below into a no-op refused for
  // being too close to the segment's own start).
  await lane.click({ position: { x: box.width * fraction, y: box.height / 2 } });
  await page.click('.split-button');
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

/** Sums every `#EXTINF` duration in a media playlist's text — the real
 * total runtime of that rendition, independent of segment count. */
export function totalPlaylistDurationSec(playlistText: string): number {
  const matches = playlistText.matchAll(/#EXTINF:([\d.]+)/g);
  let total = 0;
  for (const m of matches) total += parseFloat(m[1]);
  return total;
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

/** Downloads the current editing session as a `.remuxproj` bundle (see
 * TopBar's "Save Project") to `destPath`. */
export async function saveProjectFile(page: Page, destPath: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save Project")')]);
  await download.saveAs(destPath);
  return destPath;
}

/** Loads a `.remuxproj` bundle from `filePath` via the empty-state's own
 * "Load Project" picker and waits for the editor to come back up. */
export async function loadProjectFile(page: Page, filePath: string): Promise<void> {
  await page.locator('input[type="file"][accept=".remuxproj"]').setInputFiles(filePath);
  await page.waitForSelector('.topbar', { timeout: 30_000 });
}

/** Clicks the topbar wordmark/logo — "Start over": tears the current
 * session down completely and returns to the empty-state dropzone. */
export async function startOver(page: Page): Promise<void> {
  await page.click('.topbar-brand');
  await page.waitForSelector('.dropzone', { timeout: 10_000 });
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
