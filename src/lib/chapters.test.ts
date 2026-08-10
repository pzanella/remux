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
});
