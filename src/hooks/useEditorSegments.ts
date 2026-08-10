import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type EditorSegment,
  createInitialSegments,
  deleteSegment,
  flattenedDuration,
  locateGlobalTime,
  reorderSegments,
  splitAt,
  trimSegmentEnd,
  trimSegmentStart,
  withIds,
} from '../lib/segments';

/**
 * Owns the vertical timeline editor's segment list, selection, playhead and
 * undo/redo — the editing counterpart to `useTranscoder`, which owns the
 * transcoding lifecycle itself. Kept separate so a component only needing
 * one of the two doesn't have to thread the other's state through.
 *
 * Undo/redo is a plain snapshot stack of the segment array (immutable, so a
 * snapshot is just a reference) — one entry per completed gesture, not per
 * intermediate drag frame; callers that stream live values during a drag
 * (trim handles) should only invoke the mutating actions once, on
 * pointer-up, with the final value.
 */
export function useEditorSegments(sourceDuration: number | undefined) {
  const [segments, setSegments] = useState<EditorSegment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const undoStack = useRef<EditorSegment[][]>([]);
  const redoStack = useRef<EditorSegment[][]>([]);

  // A new source (or a reset back to none) starts a fresh single full-span
  // segment and clears history — this is a new editing session, not an edit
  // of the previous one. A loaded project's own saved cut list overwrites
  // this via `loadSegments` below, called imperatively once ingest finishes
  // rather than threaded through this effect — see that function's own
  // comment for why.
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setPlayheadTime(0);
    if (sourceDuration === undefined) {
      setSegments([]);
      setSelectedId(null);
      return;
    }
    const initial = createInitialSegments(sourceDuration);
    setSegments(initial);
    setSelectedId(initial[0]?.id ?? null);
  }, [sourceDuration]);

  // Keep the playhead inside the (possibly now-shorter) flattened timeline
  // whenever an edit changes its total length.
  useEffect(() => {
    const total = flattenedDuration(segments);
    setPlayheadTime((t) => Math.min(t, total));
  }, [segments]);

  const applyEdit = useCallback((mutate: (prev: EditorSegment[]) => EditorSegment[]) => {
    const prev = segmentsRef.current;
    const next = mutate(prev);
    if (next === prev) return; // refused (e.g. split too close to an edge, delete-the-last-one)
    undoStack.current.push(prev);
    redoStack.current = [];
    setSegments(next);
    setCanUndo(true);
    setCanRedo(false);
    setSelectedId((sel) => (sel && next.some((s) => s.id === sel) ? sel : (next[0]?.id ?? null)));
  }, []);

  const splitAtPlayhead = useCallback(() => {
    applyEdit((prev) => splitAt(prev, playheadTime));
  }, [applyEdit, playheadTime]);

  const remove = useCallback(
    (id: string) => {
      applyEdit((prev) => deleteSegment(prev, id));
    },
    [applyEdit],
  );

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      applyEdit((prev) => reorderSegments(prev, fromIndex, toIndex));
    },
    [applyEdit],
  );

  const trimStart = useCallback(
    (id: string, newSourceStart: number) => {
      applyEdit((prev) => trimSegmentStart(prev, id, newSourceStart));
    },
    [applyEdit],
  );

  const trimEnd = useCallback(
    (id: string, newSourceEnd: number) => {
      if (sourceDuration === undefined) return;
      applyEdit((prev) => trimSegmentEnd(prev, id, newSourceEnd, sourceDuration));
    },
    [applyEdit, sourceDuration],
  );

  // Trim-handle dragging updates the segment live on every pointer move
  // (so the card visibly resizes as you drag) without spamming the undo
  // stack one entry per pixel — beginGesture snapshots the pre-drag state
  // once, previewUpdate applies each intermediate value without touching
  // history, and commitGesture pushes exactly one undo entry (or none, if
  // the drag ended up back where it started) when the pointer is released.
  const gestureBaseline = useRef<EditorSegment[] | null>(null);

  const beginGesture = useCallback(() => {
    gestureBaseline.current = segmentsRef.current;
  }, []);

  const previewUpdate = useCallback((mutate: (prev: EditorSegment[]) => EditorSegment[]) => {
    setSegments((prev) => mutate(prev));
  }, []);

  const commitGesture = useCallback(() => {
    const baseline = gestureBaseline.current;
    gestureBaseline.current = null;
    if (!baseline || baseline === segmentsRef.current) return;
    undoStack.current.push(baseline);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const undo = useCallback(() => {
    const prevEntry = undoStack.current.pop();
    if (!prevEntry) return;
    redoStack.current.push(segmentsRef.current);
    setSegments(prevEntry);
    setSelectedId((sel) => (sel && prevEntry.some((s) => s.id === sel) ? sel : (prevEntry[0]?.id ?? null)));
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, []);

  const redo = useCallback(() => {
    const nextEntry = redoStack.current.pop();
    if (!nextEntry) return;
    undoStack.current.push(segmentsRef.current);
    setSegments(nextEntry);
    setSelectedId((sel) => (sel && nextEntry.some((s) => s.id === sel) ? sel : (nextEntry[0]?.id ?? null)));
    setCanRedo(redoStack.current.length > 0);
    setCanUndo(true);
  }, []);

  // Overwrites the current segments wholesale with a loaded project's saved
  // cut list — called imperatively from App.tsx right after
  // `useTranscoder.loadProject` resolves, rather than reactively off
  // `sourceDuration` (which the same load already changes, via this hook's
  // own reset effect above): calling this *after* that effect has already
  // run its trivial-reset is simpler and just as correct as trying to beat
  // it to the punch, since this always applies last regardless of exact
  // render timing, and the user only ever sees the final state — the
  // "saving-to-opfs" loading screen covers the whole sequence anyway. Clears
  // undo/redo history the same way a fresh single-segment source does; a
  // loaded project's edits aren't something you'd expect to undo past.
  const loadSegments = useCallback((ranges: { sourceStart: number; sourceEnd: number }[]) => {
    if (ranges.length === 0) return;
    const next = withIds(ranges);
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setPlayheadTime(0);
    setSegments(next);
    setSelectedId(next[0]?.id ?? null);
  }, []);

  const totalDuration = flattenedDuration(segments);
  const playheadLocation = locateGlobalTime(segments, playheadTime);

  return {
    segments,
    selectedId,
    playheadTime,
    totalDuration,
    playheadLocation,
    canUndo,
    canRedo,
    setSelectedId,
    setPlayheadTime,
    splitAtPlayhead,
    remove,
    reorder,
    trimStart,
    trimEnd,
    beginGesture,
    previewUpdate,
    commitGesture,
    loadSegments,
    undo,
    redo,
  };
}

export type UseEditorSegmentsReturn = ReturnType<typeof useEditorSegments>;
