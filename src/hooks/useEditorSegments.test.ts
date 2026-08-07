// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEditorSegments } from './useEditorSegments';

describe('useEditorSegments', () => {
  it('starts empty until a source duration is known', () => {
    const { result } = renderHook(() => useEditorSegments(undefined));
    expect(result.current.segments).toEqual([]);
    expect(result.current.totalDuration).toBe(0);
  });

  it('seeds one full-span segment once a source duration arrives, and selects it', () => {
    const { result, rerender } = renderHook(({ duration }) => useEditorSegments(duration), {
      initialProps: { duration: undefined as number | undefined },
    });
    rerender({ duration: 30 });
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 30 });
    expect(result.current.selectedId).toBe(result.current.segments[0].id);
  });

  it('resets segments and history on a new source duration', () => {
    const { result, rerender } = renderHook(({ duration }) => useEditorSegments(duration), {
      initialProps: { duration: 30 },
    });
    act(() => result.current.splitAtPlayhead()); // no-op at playhead 0, but exercise the path
    act(() => result.current.setPlayheadTime(10));
    act(() => result.current.splitAtPlayhead());
    expect(result.current.segments).toHaveLength(2);

    rerender({ duration: 50 });
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 50 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('splits at the playhead and can undo/redo the split', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.setPlayheadTime(10));
    act(() => result.current.splitAtPlayhead());

    expect(result.current.segments).toHaveLength(2);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.undo());
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.segments).toHaveLength(2);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('does not push undo history for a refused edit (e.g. deleting the last segment)', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.remove(result.current.segments[0].id));
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
  });

  it('clears the redo stack once a new edit is made after an undo', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.setPlayheadTime(10));
    act(() => result.current.splitAtPlayhead());
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.setPlayheadTime(20));
    act(() => result.current.splitAtPlayhead());
    expect(result.current.canRedo).toBe(false);
  });

  it('clamps the playhead back inside the timeline when an edit shortens it', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.setPlayheadTime(29));
    act(() => result.current.trimEnd(result.current.segments[0].id, 10));
    expect(result.current.playheadTime).toBeLessThanOrEqual(result.current.totalDuration);
    expect(result.current.totalDuration).toBe(10);
  });

  it('keeps the selection on the same segment id across a reorder', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.setPlayheadTime(10));
    act(() => result.current.splitAtPlayhead());
    const secondId = result.current.segments[1].id;
    act(() => result.current.setSelectedId(secondId));

    act(() => result.current.reorder(1, 0));
    expect(result.current.segments[0].id).toBe(secondId);
    expect(result.current.selectedId).toBe(secondId);
  });

  it('falls selection back to the first segment when the selected one is deleted', () => {
    const { result } = renderHook(() => useEditorSegments(30));
    act(() => result.current.setPlayheadTime(10));
    act(() => result.current.splitAtPlayhead());
    const [first, second] = result.current.segments;
    act(() => result.current.setSelectedId(second.id));

    act(() => result.current.remove(second.id));
    expect(result.current.segments).toEqual([first]);
    expect(result.current.selectedId).toBe(first.id);
  });

  describe('gesture (trim-drag) flow', () => {
    it('previewUpdate applies live without touching undo history until commitGesture', () => {
      const { result } = renderHook(() => useEditorSegments(30));
      const id = result.current.segments[0].id;

      act(() => result.current.beginGesture());
      act(() => result.current.previewUpdate((prev) => prev.map((s) => (s.id === id ? { ...s, sourceStart: 5 } : s))));
      expect(result.current.segments[0].sourceStart).toBe(5);
      expect(result.current.canUndo).toBe(false);

      act(() => result.current.commitGesture());
      expect(result.current.canUndo).toBe(true);

      act(() => result.current.undo());
      expect(result.current.segments[0].sourceStart).toBe(0);
    });

    it('commitGesture is a no-op when the drag ended back where it started', () => {
      const { result } = renderHook(() => useEditorSegments(30));
      act(() => result.current.beginGesture());
      act(() => result.current.commitGesture());
      expect(result.current.canUndo).toBe(false);
    });
  });
});
