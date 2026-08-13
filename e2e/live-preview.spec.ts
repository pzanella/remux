import { test, expect } from './fixtures';
import { uploadSource, attachSubtitle, addChapter, attachDubAudio } from './helpers';

// e2e/tsconfig.json's lib has no DOM (see helpers.ts's own `dropFileOnto`
// comment on the same gap) — plain inline shapes for what `.evaluate`'s
// callback actually reads at runtime, not the real DOM lib types.
interface MinimalTextTrack {
  mode: string;
  cues?: { length: number } | null;
  activeCues?: { length: number; 0?: { text: string } } | null;
}
interface MinimalVideoWithTextTracks {
  textTracks: MinimalTextTrack[];
}

/** Real native cue text from the video element's own `textTracks`, not
 * just proof a `<track>` was added — the bar this project already holds
 * chapters/subtitles export coverage to. */
async function activeCueText(video: import('@playwright/test').Locator): Promise<string | undefined> {
  return video.evaluate((v: MinimalVideoWithTextTracks) => v.textTracks[0]?.activeCues?.[0]?.text);
}

test('live preview shows subtitle cues and the current chapter label while editing, before export', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await attachSubtitle(page, 'subtitle.vtt'); // "Hello" 0-1s, "World" 1-2s
  await addChapter(page, 'Cold Open'); // at the default playhead, 0s

  await expect(page.locator('.preview-chapter-label')).toHaveText('Cold Open');

  const video = page.locator('.preview-frame video');
  // The first (only) subtitle track auto-enables once attached.
  await expect.poll(() => video.evaluate((v: MinimalVideoWithTextTracks) => v.textTracks[0]?.mode)).toBe('showing');
  // The track's own cue list loads asynchronously (it's fetched from the
  // blob URL) — wait for it before expecting any cue to be active.
  await expect.poll(() => video.evaluate((v: MinimalVideoWithTextTracks) => v.textTracks[0]?.cues?.length ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => activeCueText(video)).toBe('Hello');

  const scrubBar = page.locator('.scrub-bar');
  const box = await scrubBar.boundingBox();
  if (!box) throw new Error('.scrub-bar not found');

  // 75% of the 2s clip = 1.5s — inside the "World" cue and past the second
  // chapter's own marker, once it's placed below. Waits for the scrub to
  // actually land (via the cue it should now be inside) before adding the
  // chapter — `addChapter` reads the *current* playhead, which the click
  // above updates asynchronously.
  await scrubBar.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  await expect.poll(() => activeCueText(video)).toBe('World');
  await addChapter(page, 'Second Half'); // at the now-current playhead, ~1.5s

  await expect(page.locator('.preview-chapter-label')).toHaveText('Second Half');

  // Scrub back across the chapter boundary — both the label and the active
  // cue should revert, proving this tracks the live playhead rather than
  // latching onto whatever was last shown.
  await scrubBar.click({ position: { x: box.width * 0.25, y: box.height / 2 } }); // 0.5s
  await expect(page.locator('.preview-chapter-label')).toHaveText('Cold Open');
  await expect.poll(() => activeCueText(video)).toBe('Hello');
});

test('selecting a dub track for live preview mutes the main video and keeps the secondary audio element in lockstep', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await attachDubAudio(page, 'dub-audio.m4a'); // 3s, longer than main — fine for live preview, only export time cuts it

  await page.click('.dub-preview-toggle');

  const video = page.locator('.preview-frame video');
  const audio = page.locator('.dub-preview-audio');

  await expect.poll(() => video.evaluate((v: { muted: boolean }) => v.muted)).toBe(true);
  await expect.poll(() => audio.evaluate((a: { src: string }) => a.src)).toContain('blob:');

  await page.click('.transport-btn');
  await expect.poll(() => video.evaluate((v: { paused: boolean }) => v.paused)).toBe(false);
  await expect.poll(() => audio.evaluate((a: { paused: boolean }) => a.paused)).toBe(false);

  await page.click('.transport-btn');
  await expect.poll(() => video.evaluate((v: { paused: boolean }) => v.paused)).toBe(true);
  await expect.poll(() => audio.evaluate((a: { paused: boolean }) => a.paused)).toBe(true);

  // A scrub-seek on the main preview should carry the secondary audio
  // element along with it, not leave it sitting at its old position.
  const scrubBar = page.locator('.scrub-bar');
  const box = await scrubBar.boundingBox();
  if (!box) throw new Error('.scrub-bar not found');
  await scrubBar.click({ position: { x: box.width * 0.75, y: box.height / 2 } }); // 1.5s of 2s
  await expect.poll(() => audio.evaluate((a: { currentTime: number }) => a.currentTime)).toBeGreaterThan(1.0);

  // Deselecting the preview restores the main video's own audio.
  await page.click('.dub-preview-toggle');
  await expect.poll(() => video.evaluate((v: { muted: boolean }) => v.muted)).toBe(false);
});
