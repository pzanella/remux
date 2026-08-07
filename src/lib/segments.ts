/**
 * Pure editing logic for the vertical timeline editor — split/trim/delete/
 * reorder, and the mapping between a single flattened (post-edit) playhead
 * time and (segment, local source time) needed to drive both preview
 * playback and the rail's own layout. Nothing here touches the DOM or React
 * state; components/hooks call these to produce a new segment array and
 * re-render off that.
 */

export interface EditorSegment {
  id: string;
  /** In/out trim bounds, both source-file-relative seconds (not relative to
   * any other segment, and not relative to the flattened timeline). */
  sourceStart: number;
  sourceEnd: number;
}

/** Below this, a segment is too short to usefully trim/select/split further
 * — trim/split operations refuse to produce anything shorter than this. */
export const MIN_SEGMENT_DURATION_SEC = 0.2;

/** Shared scale between the rail's card heights and the trim-handle
 * pointer-drag math, so dragging a handle by N screen pixels always moves
 * the boundary by the same number of seconds the card's own height implies. */
export const PX_PER_SECOND = 6.4;

/** Height floor so a very short segment's card stays usable (draggable,
 * readable label) instead of collapsing to a sliver. */
export const MIN_CARD_HEIGHT_PX = 56;

/** Gap rendered between stacked cards — folded into `computeCardLayout`'s
 * cumulative offsets (rather than left to a CSS `gap`) so the playhead line
 * and spine, which are positioned from that same layout, land exactly where
 * the cards visually are instead of drifting by a few px per card. */
export const CARD_GAP_PX = 4;

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `seg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function segmentDuration(seg: { sourceStart: number; sourceEnd: number }): number {
  return Math.max(0, seg.sourceEnd - seg.sourceStart);
}

export function flattenedDuration(segments: EditorSegment[]): number {
  return segments.reduce((sum, s) => sum + segmentDuration(s), 0);
}

/** The one segment a freshly-loaded source starts as: the whole thing,
 * untrimmed. */
export function createInitialSegments(sourceDuration: number): EditorSegment[] {
  return [{ id: makeId(), sourceStart: 0, sourceEnd: Math.max(0, sourceDuration) }];
}

/** Each segment's start offset within the flattened (post-edit) timeline —
 * same length/order as `segments`. Takes only the `sourceStart`/`sourceEnd`
 * shape (not the full `EditorSegment`, which also requires `id`) so it works
 * equally against the editor's own segments and the plain `{sourceStart,
 * sourceEnd}[]` a `TranscodingSession` carries into the worker — `id` is
 * never used here anyway. */
export function segmentOffsets(segments: { sourceStart: number; sourceEnd: number }[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const s of segments) {
    offsets.push(acc);
    acc += segmentDuration(s);
  }
  return offsets;
}

export interface PlayheadLocation {
  index: number;
  segment: EditorSegment;
  /** Where this global time falls inside the segment's own source range. */
  localSourceTime: number;
}

/** Flattened global time → which segment it falls in, and where in that
 * segment's own source range. Clamps into the last segment past the end
 * (and the first segment before 0) rather than returning null, so a
 * slightly-stale playhead never has nowhere to point. */
export function locateGlobalTime(segments: EditorSegment[], globalTime: number): PlayheadLocation | null {
  if (segments.length === 0) return null;
  const offsets = segmentOffsets(segments);
  let index = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const start = offsets[i];
    const end = start + segmentDuration(segments[i]);
    if (globalTime < end || i === segments.length - 1) {
      index = i;
      break;
    }
  }
  const seg = segments[index];
  const localOffset = Math.min(Math.max(0, globalTime - offsets[index]), segmentDuration(seg));
  return { index, segment: seg, localSourceTime: seg.sourceStart + localOffset };
}

/** Inverse of `locateGlobalTime` for a known segment index + local source
 * time within it — used after a native `timeupdate` to fold the preview's
 * own (single-file) currentTime back into flattened global time. */
export function globalTimeForLocation(segments: EditorSegment[], index: number, sourceTimeWithinSegment: number): number {
  const offsets = segmentOffsets(segments);
  const seg = segments[index];
  if (!seg) return 0;
  const localOffset = Math.min(Math.max(0, sourceTimeWithinSegment - seg.sourceStart), segmentDuration(seg));
  return offsets[index] + localOffset;
}

/** Splits the segment under `globalTime` into two, at that point. Refuses
 * (returns the input array unchanged) when the cut would leave either half
 * shorter than `MIN_SEGMENT_DURATION_SEC`, or when `globalTime` doesn't
 * land inside any segment. */
export function splitAt(segments: EditorSegment[], globalTime: number): EditorSegment[] {
  const loc = locateGlobalTime(segments, globalTime);
  if (!loc) return segments;
  const { index, segment, localSourceTime } = loc;
  const firstLen = localSourceTime - segment.sourceStart;
  const secondLen = segment.sourceEnd - localSourceTime;
  if (firstLen < MIN_SEGMENT_DURATION_SEC || secondLen < MIN_SEGMENT_DURATION_SEC) return segments;

  const first: EditorSegment = { id: segment.id, sourceStart: segment.sourceStart, sourceEnd: localSourceTime };
  const second: EditorSegment = { id: makeId(), sourceStart: localSourceTime, sourceEnd: segment.sourceEnd };
  const next = [...segments];
  next.splice(index, 1, first, second);
  return next;
}

/** Removes one segment. Never drops below one remaining segment — the rail
 * always has something to show and export. */
export function deleteSegment(segments: EditorSegment[], id: string): EditorSegment[] {
  if (segments.length <= 1) return segments;
  return segments.filter((s) => s.id !== id);
}

/** Moves the segment at `fromIndex` to sit at `toIndex`, shifting the rest —
 * a plain array move, the data-side of native drag-and-drop reordering. */
export function reorderSegments(segments: EditorSegment[], fromIndex: number, toIndex: number): EditorSegment[] {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= segments.length) return segments;
  const clampedTo = Math.max(0, Math.min(segments.length - 1, toIndex));
  const next = [...segments];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clampedTo, 0, moved);
  return next;
}

/** Drags a segment's in-point. Clamped to stay within [0, sourceEnd -
 * MIN_SEGMENT_DURATION_SEC] — trimming is local to this one segment's own
 * bounds and never touches any other segment, even if their source ranges
 * now overlap (expected once segments have been split/reordered). */
export function trimSegmentStart(segments: EditorSegment[], id: string, newSourceStart: number): EditorSegment[] {
  return segments.map((s) => {
    if (s.id !== id) return s;
    const clamped = Math.min(Math.max(0, newSourceStart), s.sourceEnd - MIN_SEGMENT_DURATION_SEC);
    return { ...s, sourceStart: clamped };
  });
}

/** Drags a segment's out-point. Clamped to stay within [sourceStart +
 * MIN_SEGMENT_DURATION_SEC, sourceDuration]. */
export function trimSegmentEnd(segments: EditorSegment[], id: string, newSourceEnd: number, sourceDuration: number): EditorSegment[] {
  return segments.map((s) => {
    if (s.id !== id) return s;
    const clamped = Math.max(Math.min(newSourceEnd, sourceDuration), s.sourceStart + MIN_SEGMENT_DURATION_SEC);
    return { ...s, sourceEnd: clamped };
  });
}

export interface SegmentCardLayout {
  id: string;
  top: number;
  height: number;
}

/** Per-card pixel geometry for the rail: height proportional to trimmed
 * duration at `PX_PER_SECOND`, floored at `MIN_CARD_HEIGHT_PX` so short
 * clips stay usable. Cards stack top to bottom in array order. */
export function computeCardLayout(segments: EditorSegment[]): SegmentCardLayout[] {
  const layout: SegmentCardLayout[] = [];
  let top = 0;
  for (const s of segments) {
    const height = Math.max(MIN_CARD_HEIGHT_PX, segmentDuration(s) * PX_PER_SECOND);
    layout.push({ id: s.id, top, height });
    top += height + CARD_GAP_PX;
  }
  return layout;
}

/** Flattened global time → a Y pixel in the rail, using the same
 * floor-adjusted card layout the cards themselves render at (so the
 * playhead line always lines up with the card it's actually inside, even
 * for segments short enough to hit the height floor). */
export function globalTimeToPixel(segments: EditorSegment[], layout: SegmentCardLayout[], globalTime: number): number {
  const offsets = segmentOffsets(segments);
  const loc = locateGlobalTime(segments, globalTime);
  if (!loc) return 0;
  const card = layout[loc.index];
  const seg = segments[loc.index];
  const duration = segmentDuration(seg);
  const localGlobal = globalTime - offsets[loc.index];
  const fraction = duration > 0 ? Math.min(1, Math.max(0, localGlobal / duration)) : 0;
  return card.top + fraction * card.height;
}

/** Inverse of `globalTimeToPixel` — a Y pixel in the rail → flattened
 * global time, for click-to-scrub anywhere in the rail. */
export function pixelToGlobalTime(segments: EditorSegment[], layout: SegmentCardLayout[], y: number): number {
  if (segments.length === 0 || layout.length === 0) return 0;
  const offsets = segmentOffsets(segments);
  let index = layout.length - 1;
  for (let i = 0; i < layout.length; i++) {
    if (y < layout[i].top + layout[i].height || i === layout.length - 1) {
      index = i;
      break;
    }
  }
  const card = layout[index];
  const seg = segments[index];
  const duration = segmentDuration(seg);
  const fraction = card.height > 0 ? Math.min(1, Math.max(0, (y - card.top) / card.height)) : 0;
  return offsets[index] + fraction * duration;
}

/** Maps a `[sourceStart, sourceEnd)` range authored in the source file's own
 * time (a subtitle cue, typically) into the flattened (post-edit) output
 * timeline — the content-authored counterpart to `locateGlobalTime`, which
 * goes the other way for the playhead. Returns `null` when the range isn't
 * entirely covered by one current segment: either it falls in footage that's
 * been trimmed away, or it straddles a boundary a split/reorder introduced
 * (a cue spanning two segments has no single contiguous position once
 * they're no longer adjacent in the output — dropping it is the honest
 * answer, not guessing). Never partially clips a cue to fit; callers that
 * want that trade a wrong cue for a missing one, deliberately. */
export function remapSourceRangeToGlobal(
  segments: { sourceStart: number; sourceEnd: number }[],
  sourceStart: number,
  sourceEnd: number,
): { start: number; end: number } | null {
  const offsets = segmentOffsets(segments);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (sourceStart >= seg.sourceStart && sourceEnd <= seg.sourceEnd) {
      return { start: offsets[i] + (sourceStart - seg.sourceStart), end: offsets[i] + (sourceEnd - seg.sourceStart) };
    }
  }
  return null;
}

/** Whether the segment list represents "no real edit" — a single segment
 * spanning the whole source, unsplit and untrimmed. Mirrors the worker's
 * own `hasEditedSegments` check (remux.worker.ts) so the UI and the export
 * payload agree on what counts as an edit. */
export function isTrivialEdit(segments: { sourceStart: number; sourceEnd: number }[], sourceDuration: number): boolean {
  if (segments.length !== 1) return false;
  const only = segments[0];
  const EPSILON_SEC = 0.05;
  return Math.abs(only.sourceStart) < EPSILON_SEC && Math.abs(only.sourceEnd - sourceDuration) < EPSILON_SEC;
}
