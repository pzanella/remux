import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseCues, parseTimeInput, serializeVtt, shiftCues, type Cue } from './vtt';

describe('formatTimestamp', () => {
  it('formats hours:minutes:seconds.millis, zero-padded', () => {
    expect(formatTimestamp(3661.25)).toBe('01:01:01.250');
  });

  it('formats a sub-minute duration with a zeroed hour', () => {
    expect(formatTimestamp(5.5)).toBe('00:00:05.500');
  });

  it('clamps negative input to zero', () => {
    expect(formatTimestamp(-10)).toBe('00:00:00.000');
  });
});

describe('parseCues', () => {
  it('parses a WebVTT cue with a period-decimal timestamp', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there\n';
    const cues = parseCues(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: 'Hello there' });
  });

  it('parses an SRT cue with a comma-decimal timestamp', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello there\n';
    const cues = parseCues(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: 'Hello there' });
  });

  it('joins multi-line cue text', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nLine one\nLine two\n';
    expect(parseCues(vtt)[0].text).toBe('Line one\nLine two');
  });

  it('assigns distinct ids in order for multiple cues', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n';
    const cues = parseCues(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].id).not.toBe(cues[1].id);
  });

  it('returns an empty array for text with no cue lines', () => {
    expect(parseCues('WEBVTT\n\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const vtt = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n';
    expect(parseCues(vtt)).toHaveLength(1);
  });
});

describe('serializeVtt', () => {
  it('round-trips through parseCues', () => {
    const cues: Cue[] = [
      { id: 'a', start: 1, end: 3.5, text: 'Hello' },
      { id: 'b', start: 5, end: 6, text: 'World' },
    ];
    const reparsed = parseCues(serializeVtt(cues));
    expect(reparsed.map((c) => ({ start: c.start, end: c.end, text: c.text }))).toEqual(
      cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    );
  });

  it('starts with the WEBVTT header', () => {
    expect(serializeVtt([])).toBe('WEBVTT\n\n');
  });

  it('writes a single space for empty cue text so the block stays well-formed', () => {
    const out = serializeVtt([{ id: 'a', start: 0, end: 1, text: '' }]);
    expect(out).toContain('00:00:00.000 --> 00:00:01.000\n \n');
  });
});

describe('shiftCues', () => {
  it('shifts every cue by the given offset', () => {
    const cues: Cue[] = [{ id: 'a', start: 1, end: 2, text: 'x' }];
    expect(shiftCues(cues, 10)).toEqual([{ id: 'a', start: 11, end: 12, text: 'x' }]);
  });

  it('is a no-op for a zero offset, returning the same array reference', () => {
    const cues: Cue[] = [{ id: 'a', start: 1, end: 2, text: 'x' }];
    expect(shiftCues(cues, 0)).toBe(cues);
  });
});

describe('parseTimeInput', () => {
  it('parses plain seconds', () => {
    expect(parseTimeInput('12.5', 0)).toBe(12.5);
  });

  it('parses MM:SS', () => {
    expect(parseTimeInput('1:30', 0)).toBe(90);
  });

  it('parses HH:MM:SS', () => {
    expect(parseTimeInput('1:02:03', 0)).toBe(3723);
  });

  it('round-trips a formatTimestamp value', () => {
    expect(parseTimeInput(formatTimestamp(3723.25), 0)).toBeCloseTo(3723.25, 5);
  });

  it('falls back to the given value on unparseable input', () => {
    expect(parseTimeInput('not a time', 42)).toBe(42);
  });

  it('falls back when any colon-separated part is not a number', () => {
    expect(parseTimeInput('1:xx', 42)).toBe(42);
  });
});
