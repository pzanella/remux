import { describe, expect, it } from 'vitest';
import {
  type EditorSegment,
  CARD_GAP_PX,
  MIN_CARD_HEIGHT_PX,
  MIN_SEGMENT_DURATION_SEC,
  PX_PER_SECOND,
  computeCardLayout,
  createInitialSegments,
  deleteSegment,
  flattenedDuration,
  globalTimeForLocation,
  globalTimeToPixel,
  isTrivialEdit,
  locateGlobalTime,
  pixelToGlobalTime,
  remapSourceRangeToGlobal,
  reorderSegments,
  segmentDuration,
  segmentOffsets,
  splitAt,
  trimSegmentEnd,
  trimSegmentStart,
} from './segments';

function seg(id: string, sourceStart: number, sourceEnd: number): EditorSegment {
  return { id, sourceStart, sourceEnd };
}

describe('createInitialSegments', () => {
  it('produces one untrimmed segment spanning the whole source', () => {
    const segments = createInitialSegments(30);
    expect(segments).toHaveLength(1);
    expect(segments[0].sourceStart).toBe(0);
    expect(segments[0].sourceEnd).toBe(30);
  });

  it('clamps a negative duration to zero instead of producing an inverted range', () => {
    const segments = createInitialSegments(-5);
    expect(segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 0 });
  });
});

describe('segmentDuration / flattenedDuration', () => {
  it('never goes negative for an inverted range', () => {
    expect(segmentDuration(seg('a', 10, 5))).toBe(0);
  });

  it('sums durations across segments', () => {
    const segments = [seg('a', 0, 5), seg('b', 5, 8), seg('c', 20, 21)];
    expect(flattenedDuration(segments)).toBe(9);
  });
});

describe('segmentOffsets', () => {
  it('is the running total of prior segment durations', () => {
    const segments = [seg('a', 0, 5), seg('b', 5, 8), seg('c', 20, 21)];
    expect(segmentOffsets(segments)).toEqual([0, 5, 8]);
  });
});

describe('locateGlobalTime', () => {
  const segments = [seg('a', 10, 15), seg('b', 100, 103)];

  it('returns null for an empty segment list', () => {
    expect(locateGlobalTime([], 0)).toBeNull();
  });

  it('finds the segment a global time falls into and maps it to source time', () => {
    const loc = locateGlobalTime(segments, 2);
    expect(loc).not.toBeNull();
    expect(loc!.index).toBe(0);
    expect(loc!.localSourceTime).toBe(12);
  });

  it('crosses into the next segment once past the first ones duration', () => {
    const loc = locateGlobalTime(segments, 6);
    expect(loc!.index).toBe(1);
    expect(loc!.localSourceTime).toBe(101);
  });

  it('clamps into the last segment for a global time past the end', () => {
    const loc = locateGlobalTime(segments, 999);
    expect(loc!.index).toBe(1);
    expect(loc!.localSourceTime).toBe(103);
  });

  it('clamps into the first segment for a negative global time', () => {
    const loc = locateGlobalTime(segments, -5);
    expect(loc!.index).toBe(0);
    expect(loc!.localSourceTime).toBe(10);
  });
});

describe('globalTimeForLocation', () => {
  const segments = [seg('a', 10, 15), seg('b', 100, 103)];

  it('is the inverse of locateGlobalTime within a segment', () => {
    expect(globalTimeForLocation(segments, 1, 101)).toBe(6);
  });

  it('returns 0 for an out-of-range index', () => {
    expect(globalTimeForLocation(segments, 5, 101)).toBe(0);
  });

  it('clamps a source time outside the segments own bounds', () => {
    expect(globalTimeForLocation(segments, 0, 999)).toBe(5); // clamped to sourceEnd (15) -> offset 5
  });
});

describe('splitAt', () => {
  it('splits the segment under the given global time into two, preserving the original id on the first half', () => {
    const segments = [seg('a', 0, 10)];
    const result = splitAt(segments, 4);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'a', sourceStart: 0, sourceEnd: 4 });
    expect(result[1].sourceStart).toBe(4);
    expect(result[1].sourceEnd).toBe(10);
    expect(result[1].id).not.toBe('a');
  });

  it('refuses when the cut is not inside any segment', () => {
    expect(splitAt([], 4)).toEqual([]);
  });

  it('refuses a cut that would leave the first half shorter than the minimum', () => {
    const segments = [seg('a', 0, 10)];
    const result = splitAt(segments, MIN_SEGMENT_DURATION_SEC / 2);
    expect(result).toBe(segments);
  });

  it('refuses a cut that would leave the second half shorter than the minimum', () => {
    const segments = [seg('a', 0, 10)];
    const result = splitAt(segments, 10 - MIN_SEGMENT_DURATION_SEC / 2);
    expect(result).toBe(segments);
  });

  it('accepts a cut exactly at the minimum duration boundary', () => {
    const segments = [seg('a', 0, 10)];
    const result = splitAt(segments, MIN_SEGMENT_DURATION_SEC);
    expect(result).toHaveLength(2);
  });
});

describe('deleteSegment', () => {
  it('removes the matching segment', () => {
    const segments = [seg('a', 0, 5), seg('b', 5, 10)];
    expect(deleteSegment(segments, 'a')).toEqual([seg('b', 5, 10)]);
  });

  it('refuses to drop below one remaining segment', () => {
    const segments = [seg('a', 0, 5)];
    expect(deleteSegment(segments, 'a')).toBe(segments);
  });
});

describe('reorderSegments', () => {
  const segments = [seg('a', 0, 1), seg('b', 1, 2), seg('c', 2, 3)];

  it('moves a segment to a later index, shifting the rest left', () => {
    expect(reorderSegments(segments, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves a segment to an earlier index, shifting the rest right', () => {
    expect(reorderSegments(segments, 2, 0).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when fromIndex equals toIndex', () => {
    expect(reorderSegments(segments, 1, 1)).toBe(segments);
  });

  it('is a no-op for an out-of-range fromIndex', () => {
    expect(reorderSegments(segments, 9, 0)).toBe(segments);
  });

  it('clamps an out-of-range toIndex instead of throwing', () => {
    expect(reorderSegments(segments, 0, 99).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('trimSegmentStart', () => {
  it('moves the in-point', () => {
    const segments = [seg('a', 0, 10)];
    expect(trimSegmentStart(segments, 'a', 3)[0].sourceStart).toBe(3);
  });

  it('clamps below zero', () => {
    const segments = [seg('a', 0, 10)];
    expect(trimSegmentStart(segments, 'a', -5)[0].sourceStart).toBe(0);
  });

  it('clamps so the segment never shrinks below the minimum duration', () => {
    const segments = [seg('a', 0, 10)];
    const result = trimSegmentStart(segments, 'a', 9.95);
    expect(result[0].sourceStart).toBe(10 - MIN_SEGMENT_DURATION_SEC);
  });

  it('leaves other segments untouched', () => {
    const segments = [seg('a', 0, 10), seg('b', 10, 20)];
    const result = trimSegmentStart(segments, 'a', 3);
    expect(result[1]).toEqual(seg('b', 10, 20));
  });
});

describe('trimSegmentEnd', () => {
  it('moves the out-point', () => {
    const segments = [seg('a', 0, 10)];
    expect(trimSegmentEnd(segments, 'a', 7, 20)[0].sourceEnd).toBe(7);
  });

  it('clamps to the source duration', () => {
    const segments = [seg('a', 0, 10)];
    expect(trimSegmentEnd(segments, 'a', 999, 20)[0].sourceEnd).toBe(20);
  });

  it('clamps so the segment never shrinks below the minimum duration', () => {
    const segments = [seg('a', 0, 10)];
    const result = trimSegmentEnd(segments, 'a', 0.05, 20);
    expect(result[0].sourceEnd).toBe(0 + MIN_SEGMENT_DURATION_SEC);
  });
});

describe('computeCardLayout', () => {
  it('sizes a card proportional to duration above the height floor', () => {
    const durationSec = (MIN_CARD_HEIGHT_PX + 20) / PX_PER_SECOND;
    const layout = computeCardLayout([seg('a', 0, durationSec)]);
    expect(layout[0].height).toBeCloseTo(MIN_CARD_HEIGHT_PX + 20, 5);
  });

  it('floors a short segments card height', () => {
    const layout = computeCardLayout([seg('a', 0, 0.5)]);
    expect(layout[0].height).toBe(MIN_CARD_HEIGHT_PX);
  });

  it('stacks cards top to bottom with the gap folded into the offsets', () => {
    const segments = [seg('a', 0, 0.5), seg('b', 0, 0.5)];
    const layout = computeCardLayout(segments);
    expect(layout[0].top).toBe(0);
    expect(layout[1].top).toBe(MIN_CARD_HEIGHT_PX + CARD_GAP_PX);
  });
});

describe('globalTimeToPixel / pixelToGlobalTime round-trip', () => {
  const segments = [seg('a', 0, 20), seg('b', 20, 40)];
  const layout = computeCardLayout(segments);

  it('maps the start and end of the timeline to the layouts bounds', () => {
    expect(globalTimeToPixel(segments, layout, 0)).toBe(layout[0].top);
    const totalHeight = layout[1].top + layout[1].height;
    expect(globalTimeToPixel(segments, layout, 40)).toBeCloseTo(totalHeight, 5);
  });

  it('round-trips a mid-timeline time through pixel and back', () => {
    const px = globalTimeToPixel(segments, layout, 25);
    const time = pixelToGlobalTime(segments, layout, px);
    expect(time).toBeCloseTo(25, 5);
  });

  it('pixelToGlobalTime returns 0 for an empty timeline', () => {
    expect(pixelToGlobalTime([], [], 100)).toBe(0);
  });
});

describe('isTrivialEdit', () => {
  it('is true for a single untrimmed segment spanning the whole source', () => {
    expect(isTrivialEdit([{ sourceStart: 0, sourceEnd: 30 }], 30)).toBe(true);
  });

  it('is false once there is more than one segment', () => {
    expect(
      isTrivialEdit(
        [
          { sourceStart: 0, sourceEnd: 15 },
          { sourceStart: 15, sourceEnd: 30 },
        ],
        30,
      ),
    ).toBe(false);
  });

  it('is false for a trimmed single segment', () => {
    expect(isTrivialEdit([{ sourceStart: 2, sourceEnd: 30 }], 30)).toBe(false);
  });

  it('tolerates float noise within the epsilon', () => {
    expect(isTrivialEdit([{ sourceStart: 0.001, sourceEnd: 29.999 }], 30)).toBe(true);
  });
});

describe('remapSourceRangeToGlobal', () => {
  it('is an identity shift for an untrimmed single full-span segment', () => {
    const segments = [seg('a', 0, 30)];
    expect(remapSourceRangeToGlobal(segments, 5, 8)).toEqual({ start: 5, end: 8 });
  });

  it('shifts a cue into a trimmed segments new local offset', () => {
    // Original 0-30s trimmed to keep only 10-30s -> segment starts at source 10.
    const segments = [seg('a', 10, 30)];
    expect(remapSourceRangeToGlobal(segments, 12, 15)).toEqual({ start: 2, end: 5 });
  });

  it('finds a cue inside the second of several segments, offset by the first ones duration', () => {
    const segments = [seg('a', 0, 10), seg('b', 20, 30)];
    expect(remapSourceRangeToGlobal(segments, 22, 25)).toEqual({ start: 12, end: 15 });
  });

  it('returns null for a cue entirely inside footage that was trimmed away', () => {
    const segments = [seg('a', 10, 30)];
    expect(remapSourceRangeToGlobal(segments, 2, 5)).toBeNull();
  });

  it('returns null for a cue straddling a boundary between two segments, even if adjacent', () => {
    const segments = [seg('a', 0, 10), seg('b', 10, 30)];
    expect(remapSourceRangeToGlobal(segments, 8, 12)).toBeNull();
  });

  it('returns null for a cue spanning a gap left by a deleted middle segment', () => {
    const segments = [seg('a', 0, 10), seg('b', 20, 30)];
    expect(remapSourceRangeToGlobal(segments, 5, 25)).toBeNull();
  });

  it('follows a segment to its new position after a reorder', () => {
    // 'b' now comes before 'a' in the flattened output, even though its
    // own source range is later in the original file.
    const segments = [seg('b', 20, 30), seg('a', 0, 10)];
    expect(remapSourceRangeToGlobal(segments, 22, 25)).toEqual({ start: 2, end: 5 });
    expect(remapSourceRangeToGlobal(segments, 2, 5)).toEqual({ start: 12, end: 15 });
  });

  it('accepts a cue exactly matching a segments full bounds', () => {
    const segments = [seg('a', 10, 20)];
    expect(remapSourceRangeToGlobal(segments, 10, 20)).toEqual({ start: 0, end: 10 });
  });
});
