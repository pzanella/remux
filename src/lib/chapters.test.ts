import { describe, expect, it } from 'vitest';
import { buildChaptersVtt } from './chapters';
import { parseCues } from './vtt';

describe('buildChaptersVtt', () => {
  it('spans each chapter from its own time to the next chapter\'s', () => {
    const vtt = buildChaptersVtt(
      [
        { id: 'a', time: 0, title: 'Intro' },
        { id: 'b', time: 10, title: 'Middle' },
      ],
      30,
    );
    const cues = parseCues(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0, end: 10, text: 'Intro' });
    expect(cues[1]).toMatchObject({ start: 10, end: 30, text: 'Middle' });
  });

  it('spans the last chapter to the total duration', () => {
    const vtt = buildChaptersVtt([{ id: 'a', time: 20, title: 'Outro' }], 30);
    const cues = parseCues(vtt);
    expect(cues[0]).toMatchObject({ start: 20, end: 30 });
  });

  it('sorts out-of-order chapters by time', () => {
    const vtt = buildChaptersVtt(
      [
        { id: 'b', time: 15, title: 'Second' },
        { id: 'a', time: 0, title: 'First' },
      ],
      30,
    );
    const cues = parseCues(vtt);
    expect(cues.map((c) => c.text)).toEqual(['First', 'Second']);
  });

  it('drops a chapter at or past the total duration', () => {
    const vtt = buildChaptersVtt(
      [
        { id: 'a', time: 0, title: 'Kept' },
        { id: 'b', time: 30, title: 'Dropped' },
      ],
      30,
    );
    const cues = parseCues(vtt);
    expect(cues.map((c) => c.text)).toEqual(['Kept']);
  });

  it('falls back to a default title for an empty/blank one', () => {
    const vtt = buildChaptersVtt([{ id: 'a', time: 0, title: '   ' }], 10);
    expect(parseCues(vtt)[0].text).toBe('Chapter');
  });

  it('returns just the WEBVTT header for no chapters', () => {
    expect(buildChaptersVtt([], 30)).toBe('WEBVTT\n\n');
  });

  // The bug this covers: an attached intro splices *before* the main
  // content in the real output, but chapters are authored purely against
  // the main content's own timeline (see this file's own top comment) — so
  // the real chapters.vtt cues need shifting forward by the intro's own
  // duration, or "Chapter 1" (authored at main-content time 0) ends up
  // pointing at the very start of the intro instead.
  it('shifts every surviving cue forward by offsetSec, applied after the drop/bounds check', () => {
    const vtt = buildChaptersVtt(
      [
        { id: 'a', time: 0, title: 'Cold Open' },
        { id: 'b', time: 10, title: 'Second Half' },
      ],
      20,
      5, // a 5s intro
    );
    const cues = parseCues(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 5, end: 15, text: 'Cold Open' });
    expect(cues[1]).toMatchObject({ start: 15, end: 25, text: 'Second Half' });
  });

  it('still drops a chapter at/past totalDurationSec using the un-shifted (main-content-only) time', () => {
    const vtt = buildChaptersVtt(
      [
        { id: 'a', time: 0, title: 'Kept' },
        { id: 'b', time: 20, title: 'Dropped' },
      ],
      20,
      5,
    );
    const cues = parseCues(vtt);
    expect(cues.map((c) => c.text)).toEqual(['Kept']);
    expect(cues[0]).toMatchObject({ start: 5, end: 25 });
  });

  it('defaults offsetSec to 0 (no intro attached)', () => {
    const vtt = buildChaptersVtt([{ id: 'a', time: 0, title: 'Cold Open' }], 20);
    expect(parseCues(vtt)[0]).toMatchObject({ start: 0, end: 20 });
  });
});
