import { test, expect } from './fixtures';
import { uploadSource, addChapter, attachIntro, attachOutro, splitTimelineAt, runExport, downloadZip, listZipEntries, readZipEntryText } from './helpers';

test('a dropped chapter warns via a hover/click popup, not just an inert badge', async ({ page }) => {
  // The bug this covers: the old warning was a bare span with a native
  // `title` — hover-only, no click/touch equivalent, and no visible affordance
  // that there even was more detail to see.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s

  const track = page.locator('.timeline-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('.timeline-track not found');

  // Place a chapter near the end (~1.9s), then split at 1.6s and delete the
  // second segment — the chapter now falls outside the edit.
  await track.click({ position: { x: box.width * 0.95, y: box.height / 2 } });
  await addChapter(page, 'Near end');
  await track.click({ position: { x: box.width * 0.8, y: box.height / 2 } });
  await page.click('.timeline-toolbar .icon-btn');
  const clips = page.locator('.timeline-clip:not(.timeline-clip--extra)');
  await expect(clips).toHaveCount(2);
  await clips.nth(1).click();
  await clips.nth(1).locator('.timeline-clip-delete').click();
  await expect(clips).toHaveCount(1);

  const warning = page.locator('.chapter-ruler .track-warning');
  await expect(warning).toBeVisible();
  await expect(warning.locator('.track-warning-trigger')).toHaveText('⚠ 1');

  const popup = warning.locator('.track-warning-popup');
  await expect(popup).toBeHidden();

  await warning.hover();
  await expect(popup).toBeVisible();
  await expect(popup).toHaveText('1 chapter(s) fall outside the current edit and will be dropped at export');

  await page.mouse.move(0, 0);
  await expect(popup).toBeHidden();

  // Click toggles it open and keeps it open even after the mouse leaves —
  // the part a native `title` tooltip could never do.
  await warning.locator('.track-warning-trigger').click();
  await expect(popup).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(popup).toBeVisible();

  // An outside click closes it again.
  await page.click('.timeline-toolbar .section-label');
  await expect(popup).toBeHidden();
});

test('marks a chapter while editing and emits a chapters.vtt with the real title/timing', async ({ page }, testInfo) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await addChapter(page, 'Cold Open');

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const entries = listZipEntries(zipPath);
  expect(entries).toContain('chapters.vtt');

  const vtt = readZipEntryText(zipPath, 'chapters.vtt');
  expect(vtt).toContain('WEBVTT');
  expect(vtt).toContain('Cold Open');
  // sample.mp4 is 2s; the one chapter was placed at the playhead's default
  // 0, so its cue spans the whole clip.
  expect(vtt).toContain('00:00:00.000 --> 00:00:02.000');
});

test('a chapter after an attached intro is offset to the real spliced output position', async ({ page }, testInfo) => {
  // The bug this covers: chapters are authored purely against the main
  // content's own timeline (time 0 = main content's own start), but an
  // attached intro splices *before* main content in the real output —
  // "Chapter 1" landed at 00:00:00.000 (the very start of the intro)
  // instead of where main content actually begins. Subtitles already
  // shifted correctly (resolveSubtitleTracks' own introDuration handling);
  // chapters didn't. Split is part of the repro this bug was reported
  // against, even though the root cause is independent of it.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await splitTimelineAt(page, 0.5); // leaves the playhead at 1s, not 0
  await attachIntro(page, 'intro.mp4'); // 1s

  // Back to (near) main-content time 0 before placing the chapter —
  // splitting above left the playhead mid-clip. x:10 rather than right at
  // the very edge — the first (still-selected after the split) segment's
  // own start trim-handle overlaps a few px past the clip's own edge and
  // would otherwise eat the click instead of scrubbing. Waits for the
  // scrub to actually land (the click resolving is not proof the
  // resulting playheadTime state update has been committed yet) before
  // reading it via "+ Chapter here" — via the chapter ruler's own
  // playhead, which (unlike the main track's, now gated on the live
  // preview's active phase) always reflects playheadTime regardless of
  // intro/outro.
  const track = page.locator('.timeline-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('.timeline-track not found');
  await track.click({ position: { x: 10, y: box.height / 2 } });
  // Passed as a string, not a typed function — it references browser-only
  // globals (document, getComputedStyle) that e2e/tsconfig.json's DOM-less
  // lib doesn't know about, even though they're real and correct once this
  // actually runs in the browser (same gap documented on other DOM-typed
  // e2e helpers in helpers.ts).
  await page.waitForFunction(`(() => {
    const el = document.querySelector('.chapter-ruler-playhead');
    return !!el && parseFloat(getComputedStyle(el).left) < 30;
  })()`);
  await addChapter(page, 'Cold Open'); // main-content time ~0

  const result = await runExport(page);
  expect(result).toBe('done');

  const zipPath = testInfo.outputPath('output.zip');
  await downloadZip(page, zipPath);
  const vtt = readZipEntryText(zipPath, 'chapters.vtt');
  expect(vtt).toContain('Cold Open');
  // x:10 above lands very close to, but not exactly at, main-content time 0
  // — so the cue's own start just needs to be *around* the 1s intro offset
  // (not exactly 00:00:01.000), while its end is fixed at introDuration +
  // mainDuration (1s + 2s) regardless of exactly where the chapter itself
  // landed.
  const match = vtt.match(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)\nCold Open/);
  if (!match) throw new Error(`no cue found for "Cold Open" in:\n${vtt}`);
  const [, sh, sm, ss, sms, eh, em, es, ems] = match;
  const startSec = Number(sh) * 3600 + Number(sm) * 60 + Number(ss) + Number(sms) / 1000;
  const endSec = Number(eh) * 3600 + Number(em) * 60 + Number(es) + Number(ems) / 1000;
  expect(startSec).toBeGreaterThanOrEqual(1); // never below the 1s intro offset
  expect(startSec).toBeLessThan(1.1); // and close to it — this is the bug's own regression bar
  expect(endSec).toBeCloseTo(3, 1); // introDuration(1) + mainDuration(2)
});

test('the Shaka seek bar shows a real inter-chapter tick but not one at the intro/outro splice points', async ({ page }) => {
  // The bug this covers: chapters only ever span the main content (never
  // intro/outro — see lib/chapters.ts's own top comment), so the very
  // first chapter's own start and the very last chapter's own end always
  // land exactly on the intro/outro splice points once either is attached
  // — Shaka's own built-in seek-bar chapter ticks have no way to know that
  // and drew a real-looking tick right there, which read as a separate
  // "intro/outro marker". A genuine transition between two chapters the
  // user actually placed must still show up.
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await attachIntro(page, 'intro.mp4'); // 1s
  await attachOutro(page, 'outro.mp4'); // 1s

  const track = page.locator('.timeline-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('.timeline-track not found');
  await track.click({ position: { x: 10, y: box.height / 2 } });
  await addChapter(page, 'First Half'); // main-content time ~0
  await track.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
  await addChapter(page, 'Second Half'); // main-content time ~1s (the real, internal boundary)

  const result = await runExport(page);
  expect(result).toBe('done');
  await page.click('.export-modal-close');

  const seekBar = page.locator('.shaka-seek-bar-container, .shaka-seek-bar').first();
  await seekBar.waitFor({ timeout: 10_000 });

  let ticks: string[] = [];
  for (let attempt = 0; attempt < 10 && ticks.length === 0; attempt++) {
    ticks = await page.locator('.player-chapter-tick').evaluateAll((els) => els.map((e) => (e as { style: { left: string } }).style.left));
    if (ticks.length === 0) await page.waitForTimeout(1_500);
  }
  // 1s intro + ~1s into a 2s main content = ~2s of a 4s total = ~50%. Exactly
  // one tick — nothing at 25% (the intro/main splice) or 75% (main/outro).
  expect(ticks).toHaveLength(1);
  expect(parseFloat(ticks[0])).toBeGreaterThan(40);
  expect(parseFloat(ticks[0])).toBeLessThan(60);

  // Shaka's own built-in chapter-tick coloring is disabled — this component
  // now owns `.shaka-chapter-markers` itself (see Player.tsx's own
  // `applyChapterTicks`).
  await expect(page.locator('.shaka-chapter-markers')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('shows the real chapter title in Shaka Player\'s native Chapters menu', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await addChapter(page, 'Cold Open');

  const result = await runExport(page);
  expect(result).toBe('done');
  await page.click('.export-modal-close');

  const seekBar = page.locator('.shaka-seek-bar-container, .shaka-seek-bar').first();
  await seekBar.waitFor({ timeout: 10_000 });

  // Player.tsx's loadChaptersTrackWithRetry can take a few seconds to land
  // (chapters.vtt is written early in the worker, but the player only
  // starts retrying once its own load() resolves) — poll the overflow menu
  // for the Chapters entry rather than assuming the first open already has
  // it.
  const overflowButton = page.locator('.shaka-overflow-menu-button');
  const chapterButton = page.locator('.shaka-chapter-button');
  let found = false;
  for (let attempt = 0; attempt < 10 && !found; attempt++) {
    await overflowButton.click();
    found = await chapterButton.isVisible().catch(() => false);
    if (!found) {
      await overflowButton.click(); // close the menu before the next poll
      await page.waitForTimeout(1_500);
    }
  }
  expect(found).toBe(true);

  await chapterButton.click();
  const chapterItem = page.locator('.shaka-chapter-item', { hasText: 'Cold Open' });
  await expect(chapterItem).toBeVisible();
});
