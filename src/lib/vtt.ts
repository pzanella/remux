/**
 * Minimal WebVTT/SRT cue parsing and serialization — shared between the
 * subtitle cue editor (main thread) and the worker's intro-offset shift, so
 * both agree on exactly the same timestamp format. Not a general-purpose
 * parser: it only looks for `-->` timing lines and the text that follows,
 * which is enough to round-trip both formats (SRT's comma decimal and
 * WebVTT's period both match) while ignoring headers, cue-index numbers,
 * and other formatting either format might carry.
 */

export interface Cue {
  id: string;
  /** Seconds from the start of whatever this track is relative to. */
  start: number;
  end: number;
  text: string;
}

const CUE_LINE_RE = /(\d+):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{3})/;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function formatTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function parseCues(text: string): Cue[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cues: Cue[] = [];
  let i = 0;
  let cueIndex = 0;

  while (i < lines.length) {
    const match = CUE_LINE_RE.exec(lines[i]);
    if (match) {
      const start = toSeconds(match[1], match[2], match[3], match[4]);
      const end = toSeconds(match[5], match[6], match[7], match[8]);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      cues.push({ id: `cue-${cueIndex++}`, start, end, text: textLines.join('\n') });
    }
    i++;
  }

  return cues;
}

export function serializeVtt(cues: Cue[]): string {
  let out = 'WEBVTT\n\n';
  for (const cue of cues) {
    out += `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text || ' '}\n\n`;
  }
  return out;
}

export function shiftCues(cues: Cue[], offsetSeconds: number): Cue[] {
  if (!offsetSeconds) return cues;
  return cues.map((c) => ({ ...c, start: c.start + offsetSeconds, end: c.end + offsetSeconds }));
}
