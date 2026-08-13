/**
 * Chapter markers for the player's native chapters menu (Shaka's
 * `ChapterSelection`, via `player.addChaptersTrack`). Unlike subtitle cues
 * (authored against the *source* file and remapped through `segments` for
 * display — see `remapSourceRangeToGlobal`), a chapter is authored fresh
 * while scrubbing the *edited* preview, so `time` is already in the
 * flattened/global output timeline's own coordinates — the same space as
 * the editor's `playheadTime`. No remapping step exists for chapters, which
 * also means they don't track content across edits made *after* they were
 * placed: trimming/splitting/reordering the timeline can leave a chapter
 * pointing at a moment that no longer holds what it did when placed. That's
 * an accepted trade-off for a lightweight marker feature, not a bug — see
 * `buildChaptersVtt` below for how an out-of-range chapter is handled.
 */

import { type Cue, serializeVtt } from './vtt';

export interface ChapterMark {
  id: string;
  /** Seconds into the flattened/output timeline. */
  time: number;
  title: string;
}

/**
 * One VTT cue per chapter, each spanning from its own `time` to the next
 * chapter's (or the end of the video for the last one) — the conventional
 * WebVTT chapters shape `player.getChaptersAsync` expects each entry to
 * have both a start and an end. Chapters at or past `totalDurationSec` are
 * dropped rather than emitted with a zero/negative-length cue, mirroring
 * how `CaptionLane` drops subtitle cues that fall outside the current edit.
 *
 * `totalDurationSec` is always the *main content's own* duration — chapters
 * are authored against the main clip only (see this file's own top comment)
 * and never against an attached intro/outro, so both the drop check and the
 * last chapter's own end use that, not the whole spliced output's length.
 * `offsetSec` (an attached intro's own duration, or 0) is applied *after*
 * that filtering step, shifting every surviving cue's start/end forward so
 * they land correctly in the real, spliced output's own timeline — the
 * same two-step shape `resolveSubtitleTracks` (remux.worker.ts) already
 * uses for subtitle cues, which is why those were never affected by this.
 */
export function buildChaptersVtt(chapters: ChapterMark[], totalDurationSec: number, offsetSec = 0): string {
  const sorted = [...chapters].filter((c) => c.time >= 0 && c.time < totalDurationSec).sort((a, b) => a.time - b.time);
  const cues: Cue[] = sorted.map((chapter, i) => ({
    id: chapter.id,
    start: chapter.time + offsetSec,
    end: (i + 1 < sorted.length ? sorted[i + 1].time : totalDurationSec) + offsetSec,
    text: chapter.title.trim() || 'Chapter',
  }));
  return serializeVtt(cues);
}
