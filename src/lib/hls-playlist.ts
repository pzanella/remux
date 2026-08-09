/**
 * Pure HLS playlist-building and rendition-geometry helpers shared by every
 * encode path in remux.worker.ts (fast path, FFmpeg ABR, WebCodecs ABR, and
 * the segmented/edited fast path). Nothing here touches OPFS, WebCodecs,
 * FFmpeg, Wasm, or postMessage — every function is a plain string/array
 * transform of its own arguments, which is what makes this module
 * unit-testable without mocking any browser API the worker itself needs.
 */

import type { AbrRendition, TranscodingSession } from '../types';
import { isTrivialEdit } from './segments';

// ── Sidecar track constants ─────────────────────────────────────────
//
// HLS subtitles and alternate/dub audio are both sidecar playlists
// referenced from the master/multivariant playlist via #EXT-X-MEDIA, never
// muxed into the video/audio segments themselves.

export const SUBTITLES_GROUP_ID = 'subs';

export const AUDIO_GROUP_ID = 'aud';
export const ORIGINAL_AUDIO_PLAYLIST = 'audio_orig.m3u8';
export const ORIGINAL_AUDIO_SEGMENT_PREFIX = 'audio_orig_';

/** Filenames for one subtitle track's raw VTT file and its wrapper media
 * playlist (see `buildSubtitlePlaylist`) — keyed off the track's own
 * language rather than a fixed name, since more than one subtitle track can
 * exist at once. Two tracks sharing the same language code would collide;
 * the dub-audio tracks below accept the same tradeoff for the same reason
 * (simplicity over guarding an edge case neither the UI nor a real playlist
 * needs to distinguish). */
export function subtitleVttFilename(language: string): string {
  return `subtitles_${language}.vtt`;
}
export function subtitlePlaylistFilename(language: string): string {
  return `subtitles_${language}.m3u8`;
}

export interface SubtitleTag {
  name: string;
  /** BCP-47 code, e.g. "en", "it". Without this, HLS defaults the track's
   * language to "und" (undetermined) — which is what made Shaka's UI show
   * "Undetermined" in the subtitle menu instead of a real language name;
   * the NAME attribute isn't what stock player UIs surface there. */
  language: string;
  playlist: string;
  isDefault: boolean;
}

export interface AudioTrackTag {
  name: string;
  language: string;
  playlist: string;
  isDefault: boolean;
}

// ── Rendition geometry ──────────────────────────────────────────────

/** Standard 16:9 widths, used only when the source's real aspect ratio wasn't probed. */
const FALLBACK_WIDTH_BY_HEIGHT: Record<number, number> = { 240: 426, 360: 640, 480: 854, 720: 1280 };

export function computeRenditionWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
  if (sourceWidth > 0 && sourceHeight > 0) {
    return Math.round((sourceWidth / sourceHeight) * (targetHeight / 2)) * 2;
  }
  return FALLBACK_WIDTH_BY_HEIGHT[targetHeight] ?? targetHeight;
}

/** Fits a `srcW x srcH` frame into a `dstW x dstH` box without changing its
 * own aspect ratio — letterboxed (black bars top/bottom) or pillarboxed
 * (black bars left/right) as needed, never stretched or cropped. Used to
 * draw a decoded video frame onto a differently-shaped rendition canvas —
 * matters whenever a source frame's own aspect ratio doesn't already match
 * the canvas it's being drawn onto (main content never hits this in
 * practice, since its own canvases are always sized from its own aspect
 * ratio; an intro/outro clip with a different native aspect ratio than the
 * main content routinely does). */
export function computeLetterboxRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}

/** A one-off "rendition" matching the main content's own resolution —
 * reuses the ABR encode pipeline to letterbox/pillarbox an intro/outro
 * clip into that exact size, without it needing to be an actual ladder
 * rung. Bitrate is generous (bumpers are short; quality matters more than
 * file size here) and floored well above the 96kbps WebCodecs AAC floor
 * documented on ABR_LADDER. */
export function matchMainRendition(mainHeight: number): AbrRendition {
  return {
    height: mainHeight,
    label: 'main',
    videoBitrateKbps: Math.max(1200, Math.round(mainHeight * 6)),
    audioBitrateKbps: 128,
  };
}

// ── Playlist text building ──────────────────────────────────────────

export function buildSubtitleMediaTag({ name, language, playlist, isDefault }: SubtitleTag): string {
  return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLES_GROUP_ID}",NAME="${name}",LANGUAGE="${language}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${playlist}"\n`;
}

/** Writes the one-segment media playlist that wraps one subtitle track's raw
 * VTT file. Per RFC 8216 §4.3.4.1, #EXT-X-MEDIA's URI for TYPE=SUBTITLES
 * must point to a *Media Playlist*, not a raw WebVTT file directly — Shaka
 * (and any spec-correct HLS player) fetches that URI expecting `#EXTM3U` as
 * the first line, and errors (HLS_PLAYLIST_HEADER_MISSING) on raw VTT
 * content. This wraps the single whole-file VTT in a one-segment VOD
 * playlist, the standard pattern for "not actually segmented" WebVTT in
 * HLS. `totalDurationSec` should be the *video's* total duration (main
 * content plus any spliced intro/outro), not the VTT's own span: a WebVTT
 * file with cues shorter or longer than the video is fine either way — cues
 * keep their own internal timestamps regardless of this wrapper, and any
 * past the video's end simply never get reached. */
export function buildSubtitlePlaylist(totalDurationSec: number, vttFilename: string): string {
  const target = Math.max(1, Math.ceil(totalDurationSec));
  return (
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    `#EXT-X-TARGETDURATION:${target}\n` +
    '#EXT-X-MEDIA-SEQUENCE:0\n' +
    '#EXT-X-PLAYLIST-TYPE:VOD\n' +
    `#EXTINF:${totalDurationSec.toFixed(6)},\n` +
    `${vttFilename}\n` +
    '#EXT-X-ENDLIST\n'
  );
}

export function buildAudioMediaTag({ name, language, playlist, isDefault }: AudioTrackTag): string {
  return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP_ID}",NAME="${name}",LANGUAGE="${language}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${playlist}"\n`;
}

export function buildMasterM3U8(
  streamInfos: { rendition: AbrRendition; playlist: string; width: number }[],
  subtitleTags?: SubtitleTag[],
  audioTags?: AudioTrackTag[],
): string {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  if (subtitleTags) for (const tag of subtitleTags) m += buildSubtitleMediaTag(tag);
  if (audioTags) for (const tag of audioTags) m += buildAudioMediaTag(tag);
  for (const { rendition, playlist, width } of streamInfos) {
    // With dub-audio, every rendition's own audio was dropped in favor of
    // the shared "aud" group (see buildAudioOnlyRenditions) — the
    // audioBitrateKbps folded into BANDWIDTH here is nominal in that case
    // (no per-rendition audio encode happened), same tradeoff subtitles
    // already make by not affecting BANDWIDTH at all.
    const bandwidth = (rendition.videoBitrateKbps + rendition.audioBitrateKbps) * 1000;
    const subsAttr = subtitleTags?.length ? `,SUBTITLES="${SUBTITLES_GROUP_ID}"` : '';
    const audioAttr = audioTags?.length ? `,AUDIO="${AUDIO_GROUP_ID}"` : '';
    m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${rendition.height}${subsAttr}${audioAttr}\n`;
    m += `${playlist}\n`;
  }
  return m;
}

export function buildFastPathMasterM3U8(
  bandwidth: number,
  width: number | undefined,
  height: number | undefined,
  subtitleTags: SubtitleTag[] | undefined,
  audioTags: AudioTrackTag[] | undefined,
): string {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  if (subtitleTags) for (const tag of subtitleTags) m += buildSubtitleMediaTag(tag);
  if (audioTags) for (const tag of audioTags) m += buildAudioMediaTag(tag);
  const resAttr = width && height ? `,RESOLUTION=${width}x${height}` : '';
  const subsAttr = subtitleTags?.length ? `,SUBTITLES="${SUBTITLES_GROUP_ID}"` : '';
  const audioAttr = audioTags?.length ? `,AUDIO="${AUDIO_GROUP_ID}"` : '';
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resAttr}${subsAttr}${audioAttr}\n`;
  m += 'index.m3u8\n';
  return m;
}

/** Master playlist for the fMP4 fast path's single video rendition +
 * shared "Original" audio group — version 7 (see `buildFmp4MediaPlaylist`
 * for why), and always exactly one audio tag, unlike
 * `buildFastPathMasterM3U8`'s optional subtitle/multi-dub-audio tags: the
 * fMP4 fast path doesn't support those yet (see `outputContainer` on
 * `TranscodingSession`), so this only ever needs to describe the one
 * "Original" track the source's own audio becomes. */
export function buildFmp4MasterM3U8(bandwidth: number, width: number | undefined, height: number | undefined, videoPlaylist: string, audioPlaylist: string): string {
  const resAttr = width && height ? `,RESOLUTION=${width}x${height}` : '';
  let m = '#EXTM3U\n#EXT-X-VERSION:7\n';
  m += buildAudioMediaTag({ name: 'Original', language: 'und', playlist: audioPlaylist, isDefault: true });
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resAttr},AUDIO="${AUDIO_GROUP_ID}"\n`;
  m += `${videoPlaylist}\n`;
  return m;
}

function defaultSegmentName(i: number): string {
  return `segment_${String(i).padStart(4, '0')}.ts`;
}

export function buildIntermediateM3U8(durations: number[], isFinal: boolean, segmentName: (i: number) => string = defaultSegmentName): string {
  const maxDur = Math.ceil(Math.max(...durations, 0)) + 1;
  let m = '#EXTM3U\n';
  m += '#EXT-X-VERSION:3\n';
  m += `#EXT-X-TARGETDURATION:${maxDur}\n`;
  m += '#EXT-X-MEDIA-SEQUENCE:0\n';
  for (let i = 0; i < durations.length; i++) {
    m += `#EXTINF:${durations[i].toFixed(6)},\n`;
    m += `${segmentName(i)}\n`;
  }
  if (isFinal) m += '#EXT-X-ENDLIST\n';
  return m;
}

/** HLS-on-fMP4 media playlist: one `#EXT-X-MAP` pointing at a rendition's
 * shared init segment, then one `.m4s` fragment per `#EXTINF` — the CMAF-
 * style counterpart of `buildIntermediateM3U8`'s MPEG-TS segment list.
 * Version 7 is what `#EXT-X-MAP` needs outside an I-frame-only playlist
 * (RFC 8216 §7); MPEG-TS output elsewhere in this codebase only ever needs
 * version 3, which is why this isn't just `buildIntermediateM3U8` with an
 * extra parameter. */
export function buildFmp4MediaPlaylist(durations: number[], initFilename: string, fragmentName: (i: number) => string): string {
  const maxDur = Math.ceil(Math.max(...durations, 0)) + 1;
  let m = '#EXTM3U\n';
  m += '#EXT-X-VERSION:7\n';
  m += `#EXT-X-TARGETDURATION:${maxDur}\n`;
  m += '#EXT-X-MEDIA-SEQUENCE:0\n';
  m += `#EXT-X-MAP:URI="${initFilename}"\n`;
  for (let i = 0; i < durations.length; i++) {
    m += `#EXTINF:${durations[i].toFixed(6)},\n`;
    m += `${fragmentName(i)}\n`;
  }
  m += '#EXT-X-ENDLIST\n';
  return m;
}

// ── Playlist text parsing/splicing ──────────────────────────────────

/** Sums every #EXTINF value in an already-built playlist — used to get the
 * *actual* total duration (main content plus any spliced intro/outro) for
 * the subtitle playlist wrapper, without threading a separate duration
 * figure through every call site that can produce a final playlist. */
export function totalDurationFromPlaylist(playlistText: string): number {
  let total = 0;
  for (const match of playlistText.matchAll(/#EXTINF:([\d.]+)/g)) {
    total += parseFloat(match[1]);
  }
  return total;
}

/** Every individual `#EXTINF` duration, in playlist order — unlike
 * `totalDurationFromPlaylist` (which only needs the sum), this is used to
 * recover a rendition's *real* per-segment cut points for
 * `buildAudioOnlyRenditions`, since ABR renditions are cut by forced
 * keyframes at encode time, not by any pre-computed boundary list the way
 * the fast path's are. */
export function durationsFromPlaylist(playlistText: string): number[] {
  return [...playlistText.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
}

/** Individual segment durations → cumulative end times, the boundary shape
 * `buildAudioOnlyRenditions`/`segment_audio_at_boundaries` expect. */
export function cumulativeBoundaries(durations: number[]): number[] {
  let acc = 0;
  return durations.map((d) => (acc += d));
}

/** Keeps only the `#EXTINF`/segment-name pairs from a playlist, dropping its
 * own header (`#EXTM3U`, `#EXT-X-TARGETDURATION`, ...) and footer
 * (`#EXT-X-ENDLIST`) — the piece that's actually source-specific when
 * splicing several playlists (WebCodecs- or FFmpeg-generated, both are
 * plain text either way) into one. */
export function extractPlaylistBody(playlistText: string): string {
  return playlistText
    .split('\n')
    .filter((line) => line.startsWith('#EXTINF') || (line.trim() !== '' && !line.startsWith('#')))
    .join('\n');
}

/** Concatenates 1-3 already-complete variant playlists (intro/main/outro,
 * in that order) for the *same* rendition into one, with an
 * #EXT-X-DISCONTINUITY between each — the ABR counterpart of the fast
 * path's duration-array-based playlists, for pre-built playlist text
 * instead. */
export function spliceM3U8Texts(playlistTexts: string[]): string {
  const targetDuration = Math.max(
    1,
    ...playlistTexts.map((t) => parseInt(t.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] ?? '0', 10)),
  );
  let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
  playlistTexts.forEach((text, i) => {
    if (i > 0) m += '#EXT-X-DISCONTINUITY\n';
    const body = extractPlaylistBody(text);
    if (body) m += `${body}\n`;
  });
  m += '#EXT-X-ENDLIST\n';
  return m;
}

// ── Encoded-chunk concatenation ───────────────────────────────────────

export function concatChunks(chunks: { data: Uint8Array }[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c.data, offset);
    offset += c.data.byteLength;
  }
  return out;
}

// ── Edit detection ────────────────────────────────────────────────────

/** Whether a transcoding session's segment list represents a real edit
 * (more than one segment, or a single segment that's been trimmed) rather
 * than the untouched whole file. Delegates the single-segment "is this
 * span the whole file" check to `isTrivialEdit` — the same function the
 * editor UI itself uses (see src/lib/segments.ts) — so the UI and the
 * worker can never quietly disagree about what counts as an edit. */
export function hasEditedSegments(session: Pick<TranscodingSession, 'segments' | 'sourceDuration'>): boolean {
  const segs = session.segments;
  if (!segs || segs.length === 0) return false;
  if (segs.length > 1) return true;
  const duration = session.sourceDuration;
  if (duration === undefined) return true;
  return !isTrivialEdit(segs, duration);
}
