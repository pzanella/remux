import { test, expect } from './fixtures';
import { uploadSource, attachSubtitle, addChapter } from './helpers';

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
  // chapter's own marker, once it's placed below.
  await scrubBar.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  await addChapter(page, 'Second Half'); // at the now-current playhead, ~1.5s

  await expect(page.locator('.preview-chapter-label')).toHaveText('Second Half');
  await expect.poll(() => activeCueText(video)).toBe('World');

  // Scrub back across the chapter boundary — both the label and the active
  // cue should revert, proving this tracks the live playhead rather than
  // latching onto whatever was last shown.
  await scrubBar.click({ position: { x: box.width * 0.25, y: box.height / 2 } }); // 0.5s
  await expect(page.locator('.preview-chapter-label')).toHaveText('Cold Open');
  await expect.poll(() => activeCueText(video)).toBe('Hello');
});
