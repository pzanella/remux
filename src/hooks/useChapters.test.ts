// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChapters } from './useChapters';

describe('useChapters', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useChapters(30));
    expect(result.current.chapters).toEqual([]);
  });

  it('adds a chapter at a given time with a default title, returning its id', () => {
    const { result } = renderHook(() => useChapters(30));
    let newId = '';
    act(() => {
      newId = result.current.addChapterAt(10);
    });
    expect(result.current.chapters).toHaveLength(1);
    expect(result.current.chapters[0]).toMatchObject({ id: newId, time: 10, title: 'Chapter 1' });
  });

  it('keeps chapters sorted by time regardless of add order', () => {
    const { result } = renderHook(() => useChapters(30));
    act(() => result.current.addChapterAt(20));
    act(() => result.current.addChapterAt(5));
    expect(result.current.chapters.map((c) => c.time)).toEqual([5, 20]);
  });

  it('renames a chapter by id', () => {
    const { result } = renderHook(() => useChapters(30));
    act(() => result.current.addChapterAt(0));
    const id = result.current.chapters[0].id;
    act(() => result.current.renameChapter(id, 'Cold Open'));
    expect(result.current.chapters[0].title).toBe('Cold Open');
  });

  it('removes a chapter by id', () => {
    const { result } = renderHook(() => useChapters(30));
    act(() => result.current.addChapterAt(0));
    const id = result.current.chapters[0].id;
    act(() => result.current.removeChapter(id));
    expect(result.current.chapters).toEqual([]);
  });

  it('resets chapters when the source duration changes', () => {
    const { result, rerender } = renderHook(({ duration }) => useChapters(duration), {
      initialProps: { duration: 30 as number | undefined },
    });
    act(() => result.current.addChapterAt(10));
    expect(result.current.chapters).toHaveLength(1);

    rerender({ duration: 50 });
    expect(result.current.chapters).toEqual([]);
  });

  it('loadChapters overwrites the current list with a loaded project\'s saved one, minting fresh ids', () => {
    const { result } = renderHook(() => useChapters(30));
    act(() => result.current.addChapterAt(5));
    expect(result.current.chapters).toHaveLength(1);

    act(() => result.current.loadChapters([{ time: 0, title: 'Intro' }, { time: 12, title: 'Main' }]));
    expect(result.current.chapters.map(({ time, title }) => ({ time, title }))).toEqual([
      { time: 0, title: 'Intro' },
      { time: 12, title: 'Main' },
    ]);
    expect(result.current.chapters[0].id).not.toBe(result.current.chapters[1].id);
  });

  it('loadChapters with an empty list clears any existing chapters', () => {
    const { result } = renderHook(() => useChapters(30));
    act(() => result.current.addChapterAt(5));
    act(() => result.current.loadChapters([]));
    expect(result.current.chapters).toEqual([]);
  });
});
