import { useCallback, useEffect, useState } from 'react';
import type { ChapterMark } from '../lib/chapters';

let chapterSeq = 0;
function nextChapterId(): string {
  return `chapter-${Date.now()}-${chapterSeq++}`;
}

/**
 * Owns chapter-marker state for the editor — the counterpart to
 * `useEditorSegments` for #21. Deliberately no undo/redo stack here (unlike
 * segment edits, a chapter add/rename/remove is a single cheap action, not
 * a multi-step gesture worth the same history machinery).
 */
export function useChapters(sourceDuration: number | undefined) {
  const [chapters, setChapters] = useState<ChapterMark[]>([]);

  // A new source (or a reset back to none) starts a fresh editing session. A
  // loaded project's own saved chapters overwrite this via `loadChapters`
  // below, called imperatively once ingest finishes — see
  // useEditorSegments' identically-shaped `loadSegments` for why.
  useEffect(() => {
    setChapters([]);
  }, [sourceDuration]);

  // Generating the id up front (rather than inside the setState updater,
  // which may run more than once under strict-mode double-invoke) lets the
  // caller select/focus the new chapter immediately for renaming, the same
  // "authored fresh, ready to type a title" moment CaptionLane's own "+
  // Cue" gives subtitle cues.
  const addChapterAt = useCallback((time: number): string => {
    const id = nextChapterId();
    setChapters((prev) => [...prev, { id, time, title: `Chapter ${prev.length + 1}` }].sort((a, b) => a.time - b.time));
    return id;
  }, []);

  const renameChapter = useCallback((id: string, title: string) => {
    setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  const removeChapter = useCallback((id: string) => {
    setChapters((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Overwrites the current chapters wholesale with a loaded project's saved
  // list — called imperatively from App.tsx right after
  // `useTranscoder.loadProject` resolves, applied last regardless of the
  // reset effect's own timing (see loadSegments in useEditorSegments for the
  // full reasoning, identical here).
  const loadChapters = useCallback((saved: { time: number; title: string }[]) => {
    setChapters(saved.map((c) => ({ id: nextChapterId(), time: c.time, title: c.title })));
  }, []);

  return { chapters, addChapterAt, renameChapter, removeChapter, loadChapters };
}

export type UseChaptersReturn = ReturnType<typeof useChapters>;
