/**
 * remux.worker.ts — runs the whole transcoding job in a dedicated Web Worker.
 *
 * Reads the source file from OPFS with a sync access handle, drives the Wasm
 * remuxer segment by segment, and writes each segment straight to the output
 * folder. Non-MP4/MOV sources are pre-converted to H.264+AAC MP4 with
 * FFmpeg.wasm first.
 */

import type { WorkerCommand, WorkerEvent, ParseHeadersResult, AudioOnlyParseResult, SegmentInfoJs } from '../types';
import { isNativeContainer, ABR_LADDER } from '../types';
import { parseCues, serializeVtt, shiftCues } from '../lib/vtt';
import { flattenedDuration, remapSourceRangeToGlobal } from '../lib/segments';
import { buildChaptersVtt } from '../lib/chapters';
import {
  type SubtitleTag,
  type AudioTrackTag,
  ORIGINAL_AUDIO_PLAYLIST,
  ORIGINAL_AUDIO_SEGMENT_PREFIX,
  subtitleVttFilename,
  subtitlePlaylistFilename,
  computeRenditionWidth,
  computeLetterboxRect,
  matchMainRendition,
  buildSubtitlePlaylist,
  buildMasterM3U8,
  buildFastPathMasterM3U8,
  buildFmp4MasterM3U8,
  buildFmp4MediaPlaylist,
  buildFmp4MultiRenditionMasterM3U8,
  buildIntermediateM3U8,
  totalDurationFromPlaylist,
  durationsFromPlaylist,
  cumulativeBoundaries,
  spliceM3U8Texts,
  concatChunks,
  hasEditedSegments,
} from '../lib/hls-playlist';
import { buildDashManifest, type DashRendition } from '../lib/dash';

// Registered before any async work, so a stalled Wasm/FFmpeg load or a Rust
// panic always reaches the UI instead of hanging silently.
self.onerror = (msg, _src, _line, _col, err) => {
  self.postMessage({
    type: 'ERROR',
    error: `Worker uncaught error: ${err?.message ?? msg}`,
  } satisfies WorkerEvent);
};

self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  self.postMessage({
    type: 'ERROR',
    error: `Worker unhandled rejection: ${e.reason}`,
  } satisfies WorkerEvent);
});

// Both modules below are loaded lazily (only once START/RESUME arrives), so
// the message listener goes live immediately instead of waiting on a
// top-level await inside the Wasm glue file or the FFmpeg bundle.
type WasmModule = typeof import('../../packages/remux-core/remux_core.js');
let _wasmModule: WasmModule | null = null;
async function loadWasm(): Promise<WasmModule> {
  if (!_wasmModule) {
    _wasmModule = await import('../../packages/remux-core/remux_core.js');
  }
  return _wasmModule;
}

type FFmpegModule = typeof import('@ffmpeg/ffmpeg');
let _ffmpegModule: FFmpegModule | null = null;
async function loadFFmpegModule(): Promise<FFmpegModule> {
  if (!_ffmpegModule) {
    _ffmpegModule = await import('@ffmpeg/ffmpeg');
  }
  return _ffmpegModule;
}

/** Persists the ~32 MB FFmpeg core across sessions via the Cache Storage
 * API, so only the first conversion on a given browser pays the download. */
const FFMPEG_CORE_CACHE = 'remux-ffmpeg-core-v1';

async function cachedBlobURL(url: string, mimeType: string): Promise<string> {
  const cache = await caches.open(FFMPEG_CORE_CACHE);
  const cached = await cache.match(url);
  const response = cached ?? (await fetch(url));
  if (!cached && response.ok) await cache.put(url, response.clone());
  const blob = await response.blob();
  return URL.createObjectURL(new Blob([blob], { type: mimeType }));
}

/**
 * Loads ffmpeg-core.
 *
 * Must be the `esm` build, not `umd`: @ffmpeg/ffmpeg spawns its own internal
 * worker with `type: "module"`, and module workers have no `importScripts`,
 * so the umd bundle (loaded via a blob: URL, which never matches the
 * library's own default core URL) falls through to a dynamic `import()`
 * that can't parse a non-ESM script and throws "failed to import
 * ffmpeg-core.js". The esm build has a real `export default`.
 *
 * Deliberately NOT the multi-threaded `core-mt` build: it spins up a pthread
 * pool via nested Workers (our worker -> ffmpeg's internal worker -> pthread
 * workers), and that third level reliably deadlocked in testing — the job
 * would sit at "0%" forever with no error. Single-threaded is slower per
 * rendition but actually finishes.
 */
async function fetchFFmpegCoreBlobs(): Promise<{ coreURL: string; wasmURL: string }> {
  const baseUrl = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/esm';
  const [coreURL, wasmURL] = await Promise.all([
    cachedBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
    cachedBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
  ]);
  return { coreURL, wasmURL };
}

async function loadFFmpegCore(ffmpeg: InstanceType<FFmpegModule['FFmpeg']>): Promise<void> {
  await ffmpeg.load(await fetchFFmpegCoreBlobs());
}

/**
 * Pre-convert a non-native source (WebM, MKV, AVI, ...) to H.264+AAC MP4 with
 * FFmpeg.wasm. Reads from OPFS, writes the result back to OPFS, and returns
 * the new OPFS filename. Progress is posted as CONVERTING events (0–100).
 */
async function convertToMp4(sourceOpfsName: string, originalFileName: string): Promise<string> {
  post({ type: 'CONVERTING', log: 'Loading FFmpeg…', convertProgress: 0 });

  const { FFmpeg } = await loadFFmpegModule();
  const { fetchFile } = await import('@ffmpeg/util');

  const ffmpeg = new FFmpeg();

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(Math.min(progress, 1) * 85) + 5; // map 0-1 to 5-90
    post({ type: 'CONVERTING', log: `Converting… ${pct}%`, convertProgress: pct });
  });

  post({ type: 'CONVERTING', log: 'Starting FFmpeg core…', convertProgress: 2 });
  await loadFFmpegCore(ffmpeg);

  const opfsRoot = await navigator.storage.getDirectory();
  const srcHandle = await opfsRoot.getFileHandle(sourceOpfsName);
  const srcFile: File = await srcHandle.getFile();

  post({ type: 'CONVERTING', log: 'Reading source file…', convertProgress: 5 });
  const ext = originalFileName.includes('.') ? originalFileName.slice(originalFileName.lastIndexOf('.')) : '.video';
  const inputName = `input${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(srcFile));

  const outputName = 'output.mp4';
  post({ type: 'CONVERTING', log: 'Converting to H.264 + AAC…', convertProgress: 10 });

  // +faststart moves moov to the front so the Rust parser finds it in the
  // first read. -g/-keyint_min force a keyframe roughly every 2s at 30fps,
  // giving ~3 keyframes per 6s segment.
  await ffmpeg.exec([
    '-i', inputName,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputName,
  ]);

  post({ type: 'CONVERTING', log: 'Saving converted file…', convertProgress: 92 });

  const outputData = await ffmpeg.readFile(outputName) as Uint8Array;
  const outputOpfsName = `converted_${Date.now()}_output.mp4`;
  const outHandle = await opfsRoot.getFileHandle(outputOpfsName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(outputData.buffer.slice(0) as ArrayBuffer);
  await writable.close();

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);
  ffmpeg.terminate();

  post({ type: 'CONVERTING', log: 'Conversion done.', convertProgress: 100 });
  return outputOpfsName;
}

/** FFmpeg fallback for a dub-audio file that isn't already an MP4-family
 * container `HlsProcessor.parse_audio_only` can read directly (`.mp3`,
 * `.wav`, ...) — same idea as `convertToMp4` above, but audio-only: a dub
 * track's own video stream, if a video file was dropped in as one, was
 * never going to be used anyway. */
async function convertAudioToM4a(sourceOpfsName: string, originalFileName: string): Promise<string> {
  const { FFmpeg } = await loadFFmpegModule();
  const { fetchFile } = await import('@ffmpeg/util');

  const ffmpeg = new FFmpeg();
  await loadFFmpegCore(ffmpeg);

  const opfsRoot = await navigator.storage.getDirectory();
  const srcHandle = await opfsRoot.getFileHandle(sourceOpfsName);
  const srcFile: File = await srcHandle.getFile();

  const ext = originalFileName.includes('.') ? originalFileName.slice(originalFileName.lastIndexOf('.')) : '.audio';
  const inputName = `input${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(srcFile));

  const outputName = 'output.m4a';
  await ffmpeg.exec(['-i', inputName, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', outputName]);

  const outputData = (await ffmpeg.readFile(outputName)) as Uint8Array;
  const outputOpfsName = `converted_${Date.now()}_dub.m4a`;
  const outHandle = await opfsRoot.getFileHandle(outputOpfsName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(outputData.buffer.slice(0) as ArrayBuffer);
  await writable.close();

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);
  ffmpeg.terminate();

  return outputOpfsName;
}

/** Synthesizes a short held-title/closing-logo video clip from a still
 * image — `-loop 1` repeats the single frame for `holdDurationSec`, paired
 * with a silent audio track (an audio-less clip spliced next to
 * audio-bearing segments risks a real playback glitch, so one is always
 * included) and scaled/padded to `targetWidth`x`targetHeight` so the result
 * matches the main content's own dimensions exactly — see
 * `resolveIntroOutroClip`, the only caller, for why that matters. Follows
 * the same OPFS-in/OPFS-out shape as `convertAudioToM4a` above. */
async function convertImageToClip(sourceOpfsName: string, holdDurationSec: number, targetWidth: number, targetHeight: number): Promise<string> {
  const { FFmpeg } = await loadFFmpegModule();
  const { fetchFile } = await import('@ffmpeg/util');

  const ffmpeg = new FFmpeg();
  await loadFFmpegCore(ffmpeg);

  const opfsRoot = await navigator.storage.getDirectory();
  const srcHandle = await opfsRoot.getFileHandle(sourceOpfsName);
  const srcFile: File = await srcHandle.getFile();

  const ext = sourceOpfsName.includes('.') ? sourceOpfsName.slice(sourceOpfsName.lastIndexOf('.')) : '.img';
  const inputName = `input${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(srcFile));

  const outputName = 'output.mp4';
  await ffmpeg.exec([
    '-loop', '1',
    '-i', inputName,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo',
    '-shortest',
    '-t', String(holdDurationSec),
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputName,
  ]);

  const outputData = (await ffmpeg.readFile(outputName)) as Uint8Array;
  const outputOpfsName = `converted_${Date.now()}_held.mp4`;
  const outHandle = await opfsRoot.getFileHandle(outputOpfsName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(outputData.buffer.slice(0) as ArrayBuffer);
  await writable.close();

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);
  ffmpeg.terminate();

  return outputOpfsName;
}

/** If `isImage`, synthesizes a short held clip from the still image (see
 * `convertImageToClip` above) and returns its OPFS filename in place of the
 * original, at exactly `mainWidth`x`mainHeight` — every downstream splice/
 * encode path then treats it exactly like any other same-size video intro/
 * outro, with no image-aware branching of its own (in particular,
 * `prepareAuxiliaryClip`'s `matchesMain` check takes the fast byte-copy
 * path instead of a redundant second letterbox encode). Returns the
 * original filename unchanged for a real video clip. The synthetic file is
 * temporary — callers must clean it up themselves (e.g. via
 * `removeOutputFileQuietly` against `navigator.storage.getDirectory()`)
 * once they're done with it, the same convention `cutSegmentClip`'s own
 * callers already follow for their temp files. */
async function resolveIntroOutroClip(
  fileName: string,
  isImage: boolean | undefined,
  holdDurationSec: number | undefined,
  mainWidth: number | undefined,
  mainHeight: number | undefined,
): Promise<string> {
  if (!isImage) return fileName;
  const width = mainWidth && mainWidth > 0 ? mainWidth : 1280;
  const height = mainHeight && mainHeight > 0 ? mainHeight : 720;
  return convertImageToClip(fileName, holdDurationSec ?? 3, width, height);
}

// ── Loudness normalization (EBU R128) ──────────────────────────────
//
// I=-23 LUFS / TP=-1 dBTP / LRA=7 LU are the EBU R128 broadcast targets
// (not the louder ~-14 LUFS streaming-platform convention) — this project's
// roadmap calls out EBU R128 by name, not "loud enough for YouTube".

const LOUDNORM_TARGETS = 'I=-23:TP=-1:LRA=7';

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Runs FFmpeg's `loudnorm` filter once, audio-only (`-vn`, so there's no
 * video to decode at all), to measure the source's actual loudness stats —
 * the first half of the filter's own documented two-pass recipe, needed for
 * a sample-accurate correction rather than the filter's less accurate
 * single-pass "dynamic" mode. The stats come back as a JSON object the
 * filter prints to stderr (`print_format=json`), captured the same way this
 * file already captures FFmpeg's log output for error reporting (see the
 * SRT→VTT conversion in `resolveSubtitleTracks`). */
async function measureLoudness(ffmpeg: InstanceType<FFmpegModule['FFmpeg']>, inputName: string): Promise<LoudnormMeasurement> {
  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => lines.push(message);
  ffmpeg.on('log', onLog);
  try {
    const code = await ffmpeg.exec(['-i', inputName, '-vn', '-af', `loudnorm=${LOUDNORM_TARGETS}:print_format=json`, '-f', 'null', '-']);
    if (code !== 0) {
      throw new Error(`FFmpeg exited with code ${code}: ${lines.slice(-10).join(' / ')}`);
    }
  } finally {
    ffmpeg.off('log', onLog);
  }
  // The filter's own JSON block has no nested braces, so the last
  // "{...}" span in the combined log text is unambiguously it — nothing
  // else FFmpeg prints at this verbosity is brace-delimited.
  const matches = lines.join('\n').match(/\{[^{}]*\}/g);
  if (!matches) {
    throw new Error(`Could not find loudnorm's measurement output: ${lines.slice(-10).join(' / ')}`);
  }
  return JSON.parse(matches[matches.length - 1]) as LoudnormMeasurement;
}

/**
 * EBU R128 loudness normalization for one source file's main audio —
 * two-pass (measure, then apply with `linear=true` using those exact
 * measured values), the accurate form of FFmpeg's `loudnorm` filter rather
 * than its single-pass real-time approximation. Video is always
 * stream-copied (`-c:v copy`) in both passes — this never re-encodes video,
 * only ever touches audio, so it's cheap even for a long source. Reads from
 * OPFS, writes the result back to OPFS, and returns the new OPFS filename,
 * matching `convertToMp4`'s own contract so callers can treat this as just
 * another pre-processing step ahead of it.
 */
async function normalizeLoudness(sourceOpfsName: string, originalFileName: string): Promise<string> {
  post({ type: 'CONVERTING', log: 'Measuring loudness…', convertProgress: 0 });

  const { FFmpeg } = await loadFFmpegModule();
  const { fetchFile } = await import('@ffmpeg/util');

  const ffmpeg = new FFmpeg();
  await loadFFmpegCore(ffmpeg);

  const opfsRoot = await navigator.storage.getDirectory();
  const srcHandle = await opfsRoot.getFileHandle(sourceOpfsName);
  const srcFile: File = await srcHandle.getFile();

  const ext = originalFileName.includes('.') ? originalFileName.slice(originalFileName.lastIndexOf('.')) : '.video';
  const inputName = `input${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(srcFile));

  const measured = await measureLoudness(ffmpeg, inputName);

  // loudnorm's own internal processing resamples to whatever rate its
  // algorithm wants (confirmed empirically: a real 44100 Hz source came out
  // at 96000 Hz with no explicit -ar) — harmless on its own, but WebCodecs'
  // own AAC encoder (used by adaptive HLS, see ABR_ENCODE_VIDEO_CODEC)
  // only accepts 44100 or 48000 Hz and throws "Unsupported sample rate"
  // otherwise. An explicit -ar matching the *source's* own rate asks
  // ffmpeg to resample back down after the filter, undoing that leak
  // rather than shipping whatever rate loudnorm happened to pick.
  const sampleRateLines: string[] = [];
  const onSampleRateLog = ({ message }: { message: string }) => sampleRateLines.push(message);
  ffmpeg.on('log', onSampleRateLog);
  await ffmpeg.exec(['-i', inputName, '-vn', '-f', 'null', '-']).catch(() => {});
  ffmpeg.off('log', onSampleRateLog);
  const sampleRateMatch = sampleRateLines.join('\n').match(/Audio:.*?(\d+) Hz/);
  const sourceSampleRate = sampleRateMatch ? sampleRateMatch[1] : '48000';

  post({ type: 'CONVERTING', log: 'Applying loudness normalization…', convertProgress: 40 });
  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(Math.min(Math.max(progress, 0), 1) * 55) + 40; // map 0-1 to 40-95
    post({ type: 'CONVERTING', log: `Applying loudness normalization… ${pct}%`, convertProgress: pct });
  });

  const outputName = 'output.mp4';
  const applyFilter =
    `loudnorm=${LOUDNORM_TARGETS}:` +
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:` +
    `measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary`;
  const applyLines: string[] = [];
  const onApplyLog = ({ message }: { message: string }) => applyLines.push(message);
  ffmpeg.on('log', onApplyLog);
  let applyCode: number;
  try {
    applyCode = await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'copy',
      '-af', applyFilter,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', sourceSampleRate,
      '-movflags', '+faststart',
      '-y', outputName,
    ]);
  } finally {
    ffmpeg.off('log', onApplyLog);
  }
  if (applyCode !== 0) {
    ffmpeg.terminate();
    throw new Error(`FFmpeg exited with code ${applyCode}: ${applyLines.slice(-10).join(' / ')}`);
  }

  const outputData = (await ffmpeg.readFile(outputName)) as Uint8Array;
  const outputOpfsName = `normalized_${Date.now()}_output.mp4`;
  const outHandle = await opfsRoot.getFileHandle(outputOpfsName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(outputData.buffer.slice(0) as ArrayBuffer);
  await writable.close();

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);
  ffmpeg.terminate();

  post({ type: 'CONVERTING', log: 'Loudness normalization done.', convertProgress: 100 });
  return outputOpfsName;
}

// ── Thumbnail sprite / trick-play ───────────────────────────────────
//
// A scrubbing-preview storyboard: one JPEG tiling many small thumbnails
// (thumbnails.jpg) plus a WebVTT file (thumbnails.vtt) mapping each time
// range to its own tile via the "#xywh=x,y,w,h" media-fragment convention —
// the exact shape Shaka Player's own seek bar already knows how to read via
// `player.addThumbnailsTrack()` (see Player.tsx). Main content only, one
// shared sprite regardless of rendition, matching how dub-audio's shared
// audio-only rendition already established "generate once, reference
// everywhere" for this project. A real limitation worth being upfront
// about: `fps=` still decodes every source frame sequentially to pick out
// the ones it keeps, so this costs roughly a full decode pass even though
// only a handful of frames end up in the sprite — a per-thumbnail seek
// (`-ss`) would avoid that but needs many small FFmpeg invocations instead
// of one, not worth the added complexity for what's a "nice to have"
// scrubbing aid, not the main deliverable.

const THUMBNAIL_TILE_WIDTH = 160;
const THUMBNAIL_TILE_HEIGHT = 90;
/** Caps both the sprite's own size and how long generating it takes —
 * plenty of resolution for a scrub preview even on a long source. */
const THUMBNAIL_MAX_TILES = 100;

function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * `srcBytes` must already be the source's own bytes, fully read — not an
 * OPFS filename or `File` this function reads itself — see this section's
 * own call site in `runTranscoding` for why: this runs fire-and-forget,
 * concurrently with the main pipeline, and the instant that pipeline's own
 * `COMPLETE` event reaches React, `deleteSession` deletes the OPFS source
 * file — for a fast native-remux job, confirmed happening well under a
 * second, before this function would otherwise get around to reading it.
 * Tried keeping just a `File` object (`FileSystemFileHandle.getFile()`)
 * across that window first, expecting it to behave as an independent
 * snapshot the way the underlying spec describes — it doesn't, at least for
 * an OPFS-backed handle in practice: reading it after the backing entry is
 * gone throws a bare "NotReadableError: The file could not be read! Code=8".
 * Reading the actual bytes before returning to the caller is the only
 * version of this that's actually safe, at the cost of paying for that read
 * up front rather than lazily — the same trade-off `convertToMp4`/
 * `normalizeLoudness` already make for their own (much larger) FFmpeg work.
 */
/** How many sequential `ffmpeg.exec()` calls one FFmpeg.wasm instance
 * tolerates before its single WASM linear memory becomes unstable —
 * confirmed empirically against a real 180s source: extracting one still
 * frame per call (see `generateThumbnailSprite` below) reliably crashed
 * with a bare "RuntimeError: memory access out of bounds" around the 65th
 * call on one instance, well past what any individual call's own memory use
 * would explain. Recycling the instance well before that (see
 * `extractThumbnailTiles`) avoids the cumulative corruption entirely. */
const FFMPEG_CALLS_PER_INSTANCE = 20;

/** Extracts one still frame per tile via a fast input-side `-ss` seek (same
 * convention `cutSegmentClip` establishes elsewhere in this file) —
 * decoding only a small window near each timestamp, rather than piping the
 * whole source through one `fps=...,tile=...` filter chain that has to
 * decode every frame sequentially to pick out the ones it keeps (that
 * single-call version costs a full decode pass on the *entire* source
 * regardless of length, a real way to blow ffmpeg.wasm's memory-constrained
 * core on a long/heavy real file — the original "Internal error" WASM abort
 * this rewrite exists to fix). Recycles the FFmpeg instance itself every
 * `FFMPEG_CALLS_PER_INSTANCE` tiles (see that constant's own doc comment)
 * and returns each tile's own JPEG bytes read back into JS memory —
 * nothing is left relying on any one instance's virtual FS surviving to a
 * later step, since the instance that wrote it may already be gone. */
async function extractThumbnailTiles(
  srcBytes: Uint8Array,
  inputName: string,
  tileCount: number,
  intervalSec: number,
  durationSec: number,
): Promise<Uint8Array[]> {
  const { FFmpeg } = await loadFFmpegModule();
  const scalePad = `scale=${THUMBNAIL_TILE_WIDTH}:${THUMBNAIL_TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${THUMBNAIL_TILE_WIDTH}:${THUMBNAIL_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`;
  const tiles: Uint8Array[] = [];

  // `writeFile` transfers (not clones) a Uint8Array's underlying buffer to
  // the FFmpeg worker (same gotcha `encodeRendition`'s own doc comment
  // flags elsewhere in this file) — reusing `srcBytes` as-is across more
  // than one instance (recycled below) would detach it after the first
  // write and leave every instance after that with nothing to read. Each
  // instance gets its own independent copy via `.slice()`.
  let ffmpeg = new FFmpeg();
  await loadFFmpegCore(ffmpeg);
  await ffmpeg.writeFile(inputName, srcBytes.slice());
  const lines: string[] = [];
  ffmpeg.on('log', ({ message }) => lines.push(message));

  try {
    for (let i = 0; i < tileCount; i++) {
      if (i > 0 && i % FFMPEG_CALLS_PER_INSTANCE === 0) {
        ffmpeg.terminate();
        ffmpeg = new FFmpeg();
        await loadFFmpegCore(ffmpeg);
        await ffmpeg.writeFile(inputName, srcBytes.slice());
        ffmpeg.on('log', ({ message }) => lines.push(message));
      }

      // Midpoint of the tile's own interval — a more representative sample
      // of the range its VTT cue covers than the interval's start would be
      // — clamped just short of the real end so a seek never lands past EOF.
      const ts = Math.max(0, Math.min(i * intervalSec + intervalSec / 2, durationSec - 0.05));
      const tileName = 'tile.jpg';
      const tileCode = await ffmpeg.exec(['-ss', ts.toFixed(3), '-i', inputName, '-frames:v', '1', '-vf', scalePad, '-q:v', '4', '-y', tileName]);
      if (tileCode !== 0) {
        throw new Error(`FFmpeg exited with code ${tileCode} extracting tile ${i}: ${lines.slice(-10).join(' / ')}`);
      }
      tiles.push((await ffmpeg.readFile(tileName)) as Uint8Array);
    }
  } finally {
    ffmpeg.terminate();
  }

  return tiles;
}

/** Composites already-extracted tile JPEGs into one grid sprite — plain
 * `OffscreenCanvas`, available in this dedicated Worker context, not
 * another FFmpeg pass. Tried feeding the tiles back into FFmpeg as an
 * `image2` sequence input for its own `tile=RxC` filter first (mirroring
 * how the rest of this file leans on FFmpeg for compositing work); that
 * combination reliably hung indefinitely (no error, no output, no exit —
 * a genuine deadlock, not just slow) with every tile already confirmed
 * successfully extracted beforehand, isolating the problem to that specific
 * image2-sequence-into-tile-filter combination rather than anything about
 * the tiles themselves. `createImageBitmap`/`OffscreenCanvas` sidesteps
 * FFmpeg for this step entirely — well-supported, uncomplicated 2D drawing,
 * nothing for a video filter graph to get stuck on. */
async function compositeThumbnailSprite(tiles: Uint8Array[], cols: number, rows: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(cols * THUMBNAIL_TILE_WIDTH, rows * THUMBNAIL_TILE_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context is unavailable in this browser.');

  for (let i = 0; i < tiles.length; i++) {
    const bitmap = await createImageBitmap(new Blob([tiles[i] as BlobPart], { type: 'image/jpeg' }));
    try {
      const col = i % cols;
      const row = Math.floor(i / cols);
      ctx.drawImage(bitmap, col * THUMBNAIL_TILE_WIDTH, row * THUMBNAIL_TILE_HEIGHT);
    } finally {
      bitmap.close();
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function generateThumbnailSprite(srcBytes: Uint8Array, originalFileName: string, outputFolderHandle: FileSystemDirectoryHandle): Promise<void> {
  const { FFmpeg } = await loadFFmpegModule();
  const probeFfmpeg = new FFmpeg();
  await loadFFmpegCore(probeFfmpeg);

  const ext = originalFileName.includes('.') ? originalFileName.slice(originalFileName.lastIndexOf('.')) : '.video';
  const inputName = `input${ext}`;

  let durationSec = 0;
  try {
    // Sliced (see extractThumbnailTiles's own comment on this same gotcha)
    // so the original `srcBytes` buffer survives intact for that call below.
    await probeFfmpeg.writeFile(inputName, srcBytes.slice());
    const durationLines: string[] = [];
    probeFfmpeg.on('log', ({ message }) => durationLines.push(message));
    await probeFfmpeg.ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputName, '-o', 'duration.txt']);
    const durationText = (await probeFfmpeg.readFile('duration.txt', 'utf8')) as string;
    durationSec = parseFloat(durationText.trim());
    if (!(durationSec > 0)) {
      throw new Error(`Could not read source duration: ${durationLines.slice(-5).join(' / ') || durationText}`);
    }
  } finally {
    probeFfmpeg.terminate();
  }

  // Sized to fill the grid the sprite actually has (cols*rows), not the
  // rougher initial estimate — otherwise a rounding-up in cols/rows would
  // leave trailing cells black for no reason.
  const roughTileCount = Math.max(1, Math.min(THUMBNAIL_MAX_TILES, Math.ceil(durationSec / 2)));
  const cols = Math.ceil(Math.sqrt(roughTileCount));
  const rows = Math.ceil(roughTileCount / cols);
  const tileCount = cols * rows;
  const intervalSec = durationSec / tileCount;

  const tiles = await extractThumbnailTiles(srcBytes, inputName, tileCount, intervalSec, durationSec);
  const spriteData = await compositeThumbnailSprite(tiles, cols, rows);
  await writeOutputFile(outputFolderHandle, 'thumbnails.jpg', spriteData);

  // One cue per tile, in the same left-to-right/top-to-bottom raster order
  // `tile=` fills the sprite in.
  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < tileCount; i++) {
    const start = i * intervalSec;
    const end = Math.min((i + 1) * intervalSec, durationSec);
    const col = i % cols;
    const row = Math.floor(i / cols);
    vtt += `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n`;
    vtt += `thumbnails.jpg#xywh=${col * THUMBNAIL_TILE_WIDTH},${row * THUMBNAIL_TILE_HEIGHT},${THUMBNAIL_TILE_WIDTH},${THUMBNAIL_TILE_HEIGHT}\n\n`;
  }
  await writeOutputFile(outputFolderHandle, 'thumbnails.vtt', vtt);
}

// ── Chapter markers ──────────────────────────────────────────────────
//
// Unlike the thumbnail sprite above, this is pure text generation — no
// FFmpeg, no reading the source's own bytes — so it's cheap enough to just
// await directly rather than needing the same fire-and-forget treatment.
// `session.chapters`' own `time` values are already in the flattened/output
// timeline's coordinates (see lib/chapters.ts), so the total duration this
// needs is the *output* duration (`session.segments`, flattened), not the
// raw source duration.
async function writeChaptersVtt(session: import('../types').TranscodingSession, outputFolderHandle: FileSystemDirectoryHandle): Promise<void> {
  if (!session.chapters?.length) return;
  const totalDurationSec = session.segments?.length ? flattenedDuration(session.segments) : (session.sourceDuration ?? 0);
  if (!(totalDurationSec > 0)) return;
  const vtt = buildChaptersVtt(session.chapters.map((c, i) => ({ id: `chapter-${i}`, time: c.time, title: c.title })), totalDurationSec);
  await writeOutputFile(outputFolderHandle, 'chapters.vtt', vtt);
}

interface RenditionResult {
  rendition: (typeof ABR_LADDER)[number];
  playlist: string;
  width: number;
  playlistText: string;
  segmentCount: number;
}

/**
 * Encodes one ABR rendition in its own FFmpeg instance (own Worker, own
 * WASM memory) — this is what lets multiple renditions run concurrently
 * instead of one after another. `inputData` is shared across parallel
 * calls, so each call takes its own copy: `ffmpeg.writeFile()` transfers
 * (not clones) a Uint8Array's underlying buffer to the target Worker,
 * which would detach it after the first rendition and leave every other
 * rendition writing an empty file.
 */
async function encodeRendition(
  FFmpeg: FFmpegModule['FFmpeg'],
  coreURL: string,
  wasmURL: string,
  rendition: (typeof ABR_LADDER)[number],
  inputName: string,
  inputData: Uint8Array,
  outputFolderHandle: FileSystemDirectoryHandle,
  sourceWidth: number,
  sourceHeight: number,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  segmentPrefix: string = '',
  // Set only when encoding a clip against another source's dimensions (an
  // intro/outro clip matched to the main content) — `scale=-2:H` alone
  // preserves *this* input's own aspect ratio, which is exactly wrong
  // there: it needs to end up at these exact pixel dimensions, letterboxed
  // or pillarboxed rather than stretched or cropped to get there.
  letterboxTarget?: { width: number; height: number },
  // With dub-audio active, every rendition drops its own embedded audio in
  // favor of the shared "aud" group `buildAudioOnlyRenditions` builds once
  // (see the WebCodecs path's identical tradeoff) — `-an` skips the audio
  // encode entirely here rather than just discarding its output, since
  // FFmpeg (unlike the WebCodecs per-rendition encoders) has no shared
  // decode-once-fan-out to lose by doing so.
  hasDubAudio = false,
): Promise<RenditionResult> {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => onProgress(Math.min(Math.max(progress, 0), 1)));

  await ffmpeg.load({ coreURL, wasmURL }, { signal });
  await ffmpeg.writeFile(inputName, inputData.slice(), { signal });

  const playlistName = `${segmentPrefix}${rendition.label}.m3u8`;
  const segmentPattern = `${segmentPrefix}${rendition.label}_%04d.ts`;
  const scaleFilter = letterboxTarget
    ? `scale=${letterboxTarget.width}:${letterboxTarget.height}:force_original_aspect_ratio=decrease,pad=${letterboxTarget.width}:${letterboxTarget.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
    : `scale=-2:${rendition.height}`;
  const audioArgs = hasDubAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', `${rendition.audioBitrateKbps}k`];

  await ffmpeg.exec(
    [
      '-i', inputName,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', `${rendition.videoBitrateKbps}k`,
      '-maxrate', `${rendition.videoBitrateKbps}k`,
      '-bufsize', `${rendition.videoBitrateKbps * 2}k`,
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      ...audioArgs,
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', segmentPattern,
      playlistName,
    ],
    undefined,
    { signal },
  );

  const playlistText = (await ffmpeg.readFile(playlistName, 'utf8')) as string;
  const segmentNames = playlistText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.ts'));

  for (const segName of segmentNames) {
    const data = (await ffmpeg.readFile(segName)) as Uint8Array;
    await writeOutputFile(outputFolderHandle, segName, data);
  }
  await writeOutputFile(outputFolderHandle, playlistName, playlistText);

  ffmpeg.terminate();

  const width = letterboxTarget ? letterboxTarget.width : computeRenditionWidth(sourceWidth, sourceHeight, rendition.height);
  return { rendition, playlist: playlistName, width, playlistText, segmentCount: segmentNames.length };
}

/**
 * Adaptive-bitrate HLS: re-encode the source once per selected rendition
 * height with FFmpeg.wasm (scale + libx264/aac), letting FFmpeg's own HLS
 * muxer cut segments directly, then stitch a master playlist referencing
 * each rendition's variant playlist. Every output file is written flat into
 * the output folder (e.g. `480p.m3u8`, `480p_0000.ts`) — filenames are
 * unique per rendition, so the existing flat-lookup Player loader needs no
 * changes and nothing is nested in subfolders.
 *
 * Runs entirely with FFmpeg, bypassing the Rust remuxer: producing a
 * genuinely different resolution requires decoding and re-encoding, which
 * the Rust side never does (it only copies existing samples). This also
 * means, unlike the fast path, ABR jobs re-encode (small quality/generation
 * loss) and are not resumable — a restart begins from scratch.
 *
 * Renditions encode in parallel (one FFmpeg instance per rendition) rather
 * than one after another — on a multi-core machine this cuts wall time
 * roughly to that of the slowest rendition instead of their sum, at the
 * cost of peak memory (one copy of the source plus its own WASM heap per
 * rendition in flight; the ladder caps this at 4). This intentionally
 * avoids the multi-threaded `core-mt` build (see loadFFmpegCore's comment)
 * — running several independent single-threaded instances side by side is
 * safe, whereas one instance's internal pthread pool deadlocked.
 *
 * There's no per-rendition boundary to pause at anymore, so Pause has no
 * effect here (same as the FFmpeg pre-conversion step). Cancel still works
 * mid-flight via an AbortSignal wired through every FFmpeg call.
 */
/** Loads one OPFS-resident source's bytes for FFmpeg, keyed off its own
 * filename for the input extension — used for the main file and, when
 * present, intro/outro clips alike. */
async function loadFFmpegInput(
  opfsRoot: FileSystemDirectoryHandle,
  opfsFileName: string,
): Promise<{ data: Uint8Array; inputName: string }> {
  const { fetchFile } = await import('@ffmpeg/util');
  const handle = await opfsRoot.getFileHandle(opfsFileName);
  const file: File = await handle.getFile();
  const data = (await fetchFile(file)) as Uint8Array;
  const ext = opfsFileName.includes('.') ? opfsFileName.slice(opfsFileName.lastIndexOf('.')) : '.video';
  return { data, inputName: `input${ext}` };
}

/**
 * Stream-copies `[sourceStart, sourceEnd)` out of an OPFS-resident source
 * file into its own OPFS file via FFmpeg's `-c copy` — no re-encode, so
 * this is fast, but (being a stream copy, not a frame-accurate re-encode)
 * cuts land on the nearest keyframe rather than the exact requested time,
 * the same precision tradeoff every other fast-path operation in this file
 * already makes. `-ss` before `-i` is input-side (fast) seeking; `-t` after
 * `-i` is a duration relative to that seek point, not an absolute end time,
 * which is what makes this correct regardless of where the clip sits in
 * the source. Used to materialize one segment of the vertical timeline
 * editor's cut list before it's remuxed/encoded like any other clip — see
 * `runSegmentedFastPath` / `runAdaptiveHlsSegmented`.
 */
async function cutSegmentClip(
  opfsRoot: FileSystemDirectoryHandle,
  sourceOpfsName: string,
  sourceStart: number,
  sourceEnd: number,
  outputOpfsName: string,
): Promise<void> {
  const { FFmpeg } = await loadFFmpegModule();
  const ffmpeg = new FFmpeg();
  try {
    await loadFFmpegCore(ffmpeg);
    const { data, inputName } = await loadFFmpegInput(opfsRoot, sourceOpfsName);
    await ffmpeg.writeFile(inputName, data);
    const outputName = 'cut_output.mp4';
    // +faststart moves moov to the front, same as convertToMp4's own reason
    // for it: without it, FFmpeg's default MP4 muxer writes moov last (it
    // can't finalize the sample table until every sample's been written),
    // which every downstream reader of this clip (both the Rust wasm
    // parser's own head-then-tail-retry and WebCodecs ABR's identical
    // fallback) has to guess around instead of just finding it up front —
    // confirmed causing a real "moov box not found in data" failure (only
    // surfacing on some cuts, not others, depending on where the tail-read
    // window happened to land) before this was added.
    await ffmpeg.exec([
      '-ss', sourceStart.toFixed(3),
      '-i', inputName,
      '-t', Math.max(0, sourceEnd - sourceStart).toFixed(3),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);
    const outputData = await ffmpeg.readFile(outputName) as Uint8Array;
    const outHandle = await opfsRoot.getFileHandle(outputOpfsName, { create: true });
    const writable = await outHandle.createWritable();
    await writable.write(outputData.buffer.slice(0) as ArrayBuffer);
    await writable.close();
  } finally {
    ffmpeg.terminate();
  }
}

/** Encodes every selected rendition for one source clip in parallel FFmpeg
 * instances — the FFmpeg counterpart of `runAbrEncodeForSource` above, used
 * once for the main content and, when present, once each for intro/outro. */
async function encodeRenditionsForSource(
  FFmpeg: FFmpegModule['FFmpeg'],
  coreURL: string,
  wasmURL: string,
  renditions: (typeof ABR_LADDER)[number][],
  inputData: Uint8Array,
  inputName: string,
  outputFolderHandle: FileSystemDirectoryHandle,
  sourceWidth: number,
  sourceHeight: number,
  segmentPrefix: string,
  logPrefix: string,
  // Set when this call is encoding an intro/outro clip against the main
  // content's own dimensions — see `encodeRendition`'s `letterboxTarget`.
  // Left unset for the main content's own encode, which should keep using
  // `scale=-2:H` (its own aspect ratio always matches itself, by
  // definition — nothing to letterbox against).
  mainDimensions?: { width: number; height: number },
  hasDubAudio = false,
): Promise<RenditionResult[]> {
  const renditionLabels = renditions.map((r) => r.label).join(', ');
  log(`${logPrefix}Encoding ${renditions.length} rendition${renditions.length > 1 ? 's' : ''} in parallel: ${renditionLabels}…`);

  abrAbortController = new AbortController();
  const { signal } = abrAbortController;

  const progressByIndex = new Array<number>(renditions.length).fill(0);
  const progressTimer = setInterval(() => {
    const avg = progressByIndex.reduce((a, b) => a + b, 0) / renditions.length;
    post({
      type: 'CONVERTING',
      log: `${logPrefix}Encoding ${renditionLabels}… ${Math.round(avg * 100)}%`,
      convertProgress: Math.min(Math.round(avg * 100), 99),
      renditionLabel: renditionLabels,
    });
  }, 500);

  try {
    return await Promise.all(
      renditions.map((rendition, idx) =>
        encodeRendition(
          FFmpeg,
          coreURL,
          wasmURL,
          rendition,
          inputName,
          inputData,
          outputFolderHandle,
          sourceWidth,
          sourceHeight,
          signal,
          (progress) => {
            progressByIndex[idx] = progress;
          },
          segmentPrefix,
          mainDimensions
            ? { width: computeRenditionWidth(mainDimensions.width, mainDimensions.height, rendition.height), height: rendition.height }
            : undefined,
          hasDubAudio,
        ),
      ),
    );
  } finally {
    clearInterval(progressTimer);
    abrAbortController = null;
  }
}

async function runAbrTranscoding(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  subtitleTags: SubtitleTag[],
): Promise<void> {
  if (cancelled) {
    log('Cancelled.');
    return;
  }

  const heights = [...(session.abrHeights ?? [])].sort((a, b) => a - b);
  if (heights.length === 0) {
    post({ type: 'ERROR', error: 'No renditions selected for the adaptive playlist.' });
    return;
  }

  const renditions = heights
    .map((h) => ABR_LADDER.find((r) => r.height === h))
    .filter((r): r is (typeof ABR_LADDER)[number] => r !== undefined);

  log('Loading source file…');
  const { FFmpeg } = await loadFFmpegModule();
  const { coreURL, wasmURL } = await fetchFFmpegCoreBlobs();
  const opfsRoot = await navigator.storage.getDirectory();

  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
  const mainDimensions = { width: sourceWidth, height: sourceHeight };
  const introName = session.introOutro?.introFileName;
  const outroName = session.introOutro?.outroFileName;
  // Mutually exclusive with intro/outro (checked in runTranscoding), so
  // introName/outroName are never set alongside this.
  const hasDubAudio = !!session.dubAudioTracks?.length;

  let introResults: RenditionResult[] | null = null;
  if (introName) {
    let resolvedIntroName: string | undefined;
    try {
      resolvedIntroName = await resolveIntroOutroClip(
        introName, session.introOutro?.introIsImage, session.introOutro?.introDuration, sourceWidth, sourceHeight,
      );
      const { data, inputName } = await loadFFmpegInput(opfsRoot, resolvedIntroName);
      introResults = await encodeRenditionsForSource(
        FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, 'intro_', '[intro] ', mainDimensions,
      );
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      log(`Could not encode the intro (${err}) — continuing without it.`, 'ERROR');
    } finally {
      if (resolvedIntroName && resolvedIntroName !== introName) await removeOutputFileQuietly(opfsRoot, resolvedIntroName);
    }
  }
  if (cancelled) {
    log('Cancelled.');
    return;
  }

  let mainResults: RenditionResult[];
  try {
    const { data, inputName } = await loadFFmpegInput(opfsRoot, session.sourceFilePath);
    mainResults = await encodeRenditionsForSource(
      FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, '', '', undefined, hasDubAudio,
    );
  } catch (err) {
    if (cancelled) {
      log('Cancelled.');
      return;
    }
    post({ type: 'ERROR', error: `Encoding failed: ${err}` });
    return;
  }
  if (cancelled) {
    log('Cancelled.');
    return;
  }

  let outroResults: RenditionResult[] | null = null;
  if (outroName) {
    let resolvedOutroName: string | undefined;
    try {
      resolvedOutroName = await resolveIntroOutroClip(
        outroName, session.introOutro?.outroIsImage, session.introOutro?.outroDuration, sourceWidth, sourceHeight,
      );
      const { data, inputName } = await loadFFmpegInput(opfsRoot, resolvedOutroName);
      outroResults = await encodeRenditionsForSource(
        FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, 'outro_', '[outro] ', mainDimensions,
      );
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      log(`Could not encode the outro (${err}) — continuing without it.`, 'ERROR');
    } finally {
      if (resolvedOutroName && resolvedOutroName !== outroName) await removeOutputFileQuietly(opfsRoot, resolvedOutroName);
    }
  }
  if (cancelled) {
    log('Cancelled.');
    return;
  }

  for (const r of mainResults) {
    post({
      type: 'SEGMENT_DONE',
      log: `${r.rendition.label} done (${r.segmentCount} segments)`,
      m3u8: r.playlistText,
      convertProgress: 100,
    });
  }

  const toAbrSourceResults = (results: RenditionResult[] | null): AbrSourceResult[] | null =>
    results && results.map((r) => ({ rendition: r.rendition, width: r.width, playlistText: r.playlistText }));

  let audioTags: AudioTrackTag[] | undefined;
  if (hasDubAudio) {
    if (mainResults.length === 0) {
      post({ type: 'ERROR', error: 'No rendition produced any output.' });
      return;
    }
    // Every rendition shares the same `-hls_time 6` target duration and the
    // same source, so their real cut points agree — any one's playlist works.
    const boundaries = cumulativeBoundaries(durationsFromPlaylist(mainResults[0].playlistText));
    const result = await buildAudioOnlyRenditions(session, outputFolderHandle, boundaries);
    if ('error' in result) {
      post({ type: 'ERROR', error: result.error });
      return;
    }
    audioTags = result;
  }

  const { masterM3u8, highestM3u8 } = await finalizeAbrResults(
    outputFolderHandle,
    toAbrSourceResults(mainResults) ?? [],
    toAbrSourceResults(introResults),
    toAbrSourceResults(outroResults),
    subtitleTags,
    audioTags,
  );

  post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
}

// ── Subtitles (optional sidecar WebVTT track) ───────────────────────
//
// HLS subtitles are a sidecar playlist referenced from the master/
// multivariant playlist via #EXT-X-MEDIA, never muxed into the video/audio
// segments themselves — so wiring them in never touches the Rust remuxer or
// its fixed-PID MPEG-TS muxer, only the JS playlist-building layer
// (src/lib/hls-playlist.ts).

// ── Dub-audio (optional alternate #EXT-X-MEDIA:TYPE=AUDIO renditions) ──
//
// Same reasoning as subtitles above: an alternate audio track is a sidecar
// referenced from the master playlist, not muxed into the video segments.
// Unlike subtitles, though, there's more than one track in play the moment
// dub-audio is used at all (the original included) — see the GROUP-ID/
// AUDIO="aud" wiring in buildFastPathMasterM3U8 and the "original" audio
// split out of the main content's own segments in runWithHandle.

/**
 * Reads every raw subtitle file the UI saved to OPFS, converts each to
 * WebVTT with FFmpeg.wasm if it's SRT, and writes the result into the
 * output folder as its own sidecar VTT file. Returns one SubtitleTag per
 * track that prepared successfully, first one marked DEFAULT — a track that
 * fails to prepare is dropped and logged rather than failing the whole
 * conversion (or the other tracks), same "degrade rather than fail"
 * tolerance the single-track version had.
 */
async function resolveSubtitleTracks(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
): Promise<SubtitleTag[]> {
  const tracks = session.subtitleTracks ?? [];
  const tags: SubtitleTag[] = [];

  for (const track of tracks) {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const fileHandle = await opfsRoot.getFileHandle(track.fileName);
      const file = await fileHandle.getFile();

      // Trust content over filename: a mislabeled extension (real SRT saved
      // as .vtt, a .vtt that's actually SRT-formatted, unusual encoding, ...)
      // would otherwise sail through untouched and only fail later, deep
      // inside Shaka's strict WebVTT parser (INVALID_TEXT_HEADER) — by which
      // point there's no good way to recover. Sniffing the actual text and
      // normalizing through FFmpeg whenever it doesn't already look like
      // WebVTT catches all of those cases the same way, regardless of cause.
      let vttText = await file.text();
      // `File.text()` decodes as UTF-8 but doesn't strip a leading byte-order
      // mark, so one — common from Windows-authored subtitle files — would
      // otherwise sit right before "WEBVTT" and make the check below miss a
      // file that's actually fine.
      if (vttText.charCodeAt(0) === 0xfeff) vttText = vttText.slice(1);
      const looksLikeWebVtt = /^WEBVTT($|[ \t\r\n])/.test(vttText);
      if (!looksLikeWebVtt) {
        // Not WebVTT-shaped and, per the catch block below, potentially not
        // SRT-shaped either — logging what the browser actually decoded (as
        // opposed to what the file is *named*) is the only way to tell
        // "wrong format entirely" apart from "wrong text encoding" without
        // access to the file itself.
        const preview = JSON.stringify(vttText.slice(0, 150));
        log(`Subtitle file "${track.label}" doesn't look like WebVTT — first ~150 chars as decoded: ${preview}`);

        // Feed FFmpeg the file as SRT regardless of its original extension:
        // the content just failed a WebVTT-shaped check, and SRT is the only
        // other format the file picker accepts — trusting the extension here
        // is exactly the assumption that got us into this branch in the
        // first place (e.g. asking FFmpeg to read genuinely SRT-formatted
        // content as `sub.vtt` makes its WebVTT demuxer choke on SRT's
        // comma-decimal timestamps instead of converting anything).
        log(`Normalizing "${track.label}" to WebVTT…`);
        const { FFmpeg } = await loadFFmpegModule();
        const ffmpeg = new FFmpeg();
        // FFmpeg's own stderr is the only thing that can actually explain a
        // conversion failure — without it, a failed exec just surfaces later
        // as an opaque "file not found" from the readFile() below, when the
        // real reason is whatever FFmpeg logged and discarded.
        const ffmpegLog: string[] = [];
        ffmpeg.on('log', ({ message }) => ffmpegLog.push(message));
        try {
          await loadFFmpegCore(ffmpeg);
          await ffmpeg.writeFile('sub.srt', new Uint8Array(await file.arrayBuffer()));
          await ffmpeg.exec(['-i', 'sub.srt', 'sub.vtt']);
          vttText = (await ffmpeg.readFile('sub.vtt', 'utf8')) as string;
        } catch (ffmpegErr) {
          throw new Error(`FFmpeg could not read this as SRT either (${ffmpegErr}). FFmpeg said: ${ffmpegLog.slice(-6).join(' / ') || '(no output)'}`);
        } finally {
          ffmpeg.terminate();
        }
      }

      // Cues are always authored in the *source file's own* time — that's
      // what an attached .srt/.vtt naturally means, and it's what the cue
      // editor shows too. Getting them into the flattened output's time
      // needs two steps: first remap each cue through the current segment
      // list (a no-op shift for the untrimmed common case, but a real
      // reposition — or an honest drop — once the timeline's been trimmed/
      // split/reordered; see remapSourceRangeToGlobal's own comment for why
      // a cue that doesn't land entirely inside one current segment is
      // dropped rather than guessed at), then shift everything forward by
      // any spliced-on intro's duration, same as before.
      const introDuration = session.introOutro?.introDuration ?? 0;
      const segments = session.segments;
      const sourceCues = parseCues(vttText);
      let outputCues = sourceCues;
      if (segments && segments.length > 0) {
        outputCues = [];
        let droppedCount = 0;
        for (const cue of sourceCues) {
          const remapped = remapSourceRangeToGlobal(segments, cue.start, cue.end);
          if (remapped) {
            outputCues.push({ ...cue, start: remapped.start, end: remapped.end });
          } else {
            droppedCount++;
          }
        }
        if (droppedCount > 0) {
          log(`${droppedCount} cue(s) in "${track.label}" fell in trimmed-out or split-across-a-boundary footage and were dropped.`);
        }
      }
      if (introDuration > 0) {
        outputCues = shiftCues(outputCues, introDuration);
      }
      vttText = serializeVtt(outputCues);

      await writeOutputFile(outputFolderHandle, subtitleVttFilename(track.language), vttText);
      tags.push({ name: track.label, language: track.language, playlist: subtitlePlaylistFilename(track.language), isDefault: tags.length === 0 });
    } catch (err) {
      log(`Could not prepare subtitles "${track.label}" (${err}) — continuing without them.`, 'ERROR');
    }
  }

  return tags;
}

// ── Adaptive HLS via WebCodecs (primary ABR path) ───────────────────
//
// Unlike `runAbrTranscoding` below (FFmpeg.wasm: one full software decode +
// encode pass per rendition, in its own Worker), this decodes the source
// exactly once — via the browser's hardware VideoDecoder/AudioDecoder — and
// fans each decoded frame out to one hardware VideoEncoder/AudioEncoder per
// selected rendition. It reuses the Rust MP4 parser the fast path already
// has (today's FFmpeg ABR path doesn't touch it) and a WebCodecs-encoded
// counterpart of the same MPEG-TS muxer (`mux_encoded_segment`). Falls back
// to `runAbrTranscoding` if WebCodecs isn't available, or the encoder
// configs for the selected renditions aren't supported — see `runAdaptiveHls`.

const ABR_SEGMENT_TARGET_SEC = 6;
/** Baseline profile: broadest hardware/software decode support for the
 * renditions' own bitstream — independent of the source's actual profile. */
const ABR_ENCODE_VIDEO_CODEC = 'avc1.42001f';

interface CodecConfig {
  videoCodec: string;
  videoDescriptionBytes: number[];
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  audioDescriptionBytes: number[];
}

interface EncodedChunkInfo {
  data: Uint8Array;
  timestampUs: number;
  isKeyframe: boolean;
}

interface CutSegment {
  videoChunks: EncodedChunkInfo[];
  audioChunks: EncodedChunkInfo[];
  startUs: number;
  endUs: number;
}

interface AbrPipelineContext {
  outputFolderHandle: FileSystemDirectoryHandle;
  processor: InstanceType<WasmModule['HlsProcessor']>;
  audioSampleRate: number;
  audioChannels: number;
  /** Namespaces segment/playlist filenames per source clip (e.g. `intro_`,
   * `outro_`, or `''` for the main content) so intro/main/outro can be
   * encoded independently and spliced together afterward without filename
   * collisions. */
  segmentPrefix: string;
  /** When true, every rendition's own (still-encoded, just discarded)
   * audio is left out of its segments — the shared "aud" group built by
   * `buildAudioOnlyRenditions` carries audio instead. See `writeRenditionSegment`. */
  hasDubAudio: boolean;
  /** 'ts' muxes each rendition's own video+audio together into MPEG-TS
   * segments (see `writeRenditionSegment`'s default branch). 'fmp4' instead
   * gives every rendition its own fMP4 video fragment stream and shares one
   * fMP4 audio fragment stream across all of them — same "one shared
   * audio-only stream, never duplicated per video quality" rule dub-audio
   * already established (see fmp4.rs's module doc comment), just applied to
   * ABR's own re-encoded audio instead of a remuxed source/dub file. Only
   * one designated sink (`RenditionSink.isAudioOwner`) ever writes that
   * shared stream; the others' own audio encode still runs (simplest to
   * leave it be, see `hasDubAudio`) but its output is discarded. */
  outputContainer: 'ts' | 'fmp4';
}

interface RenditionSink {
  rendition: (typeof ABR_LADDER)[number];
  width: number;
  playlistName: string;
  pipeline: AbrPipelineContext;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  videoEncoder: VideoEncoder;
  audioEncoder: AudioEncoder;
  segmentIndex: number;
  segmentStartUs: number;
  videoChunks: EncodedChunkInfo[];
  pendingAudioChunks: EncodedChunkInfo[];
  durations: number[];
  /** Serializes segment writes so overlapping boundary crossings can't race
   * each other's `segmentIndex`/playlist updates — see `writeRenditionSegment`. */
  writeQueue: Promise<void>;
  /** Set once this rendition's own encoder has failed — from then on it's
   * skipped (not fed more frames, not flushed again), but the *other*
   * renditions and the shared decode pipeline keep going: one rendition's
   * encoder trouble never aborts the whole job. */
  broken: boolean;
  /** fMP4 output only (see `AbrPipelineContext.outputContainer`) — whether
   * this is the one sink that writes the shared audio fragment stream.
   * Always false for 'ts' output, where every sink keeps its own audio. */
  isAudioOwner: boolean;
}

/** Marks a rendition dead after its own encoder trouble — logged once (not
 * on every subsequent call, since a broken encoder tends to keep throwing)
 * — without touching the shared decode pipeline or any other rendition. */
function markSinkBroken(sink: RenditionSink, source: string, err: unknown): void {
  if (sink.broken) return;
  sink.broken = true;
  log(`${sink.rendition.label}: ${source} failed (${err}) — continuing without this rendition from here on.`, 'ERROR');
}

function isWebCodecsAvailable(): boolean {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioDecoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined'
  );
}

/** Cheap upfront check, before touching the file: can this browser actually
 * hardware-encode every selected rendition? */
async function canUseWebCodecsAbr(
  renditions: (typeof ABR_LADDER)[number][],
  sourceWidth: number,
  sourceHeight: number,
): Promise<boolean> {
  if (!isWebCodecsAvailable()) return false;
  try {
    const checks = await Promise.all(
      renditions.map((r) =>
        VideoEncoder.isConfigSupported({
          codec: ABR_ENCODE_VIDEO_CODEC,
          width: computeRenditionWidth(sourceWidth, sourceHeight, r.height),
          height: r.height,
          bitrate: r.videoBitrateKbps * 1000,
          avc: { format: 'annexb' },
        }),
      ),
    );
    return checks.every((c) => c.supported);
  } catch {
    return false;
  }
}

/** Resolves once `getValue()` drops to `max` (or `isAborted()` turns true),
 * so a fast producer (our decode feed loop, or a decoder handing frames to
 * encoders) can't pile up unbounded work — and unbounded memory — ahead of a
 * slower consumer.
 *
 * Polls rather than listening for the codecs' own `dequeue` event: if a
 * codec errors out mid-job it stops emitting `dequeue` entirely, and an
 * event-only wait for its queue to drain would then hang forever with
 * nothing left to wake it, even though the caller's `isAborted` would now
 * say to stop. Polling always gets another chance to notice that. */
async function waitUntilBelow(getValue: () => number, max: number, isAborted: () => boolean): Promise<void> {
  while (!isAborted() && getValue() > max) {
    await sleep(20);
  }
}

function closeQuietly(codec: { close(): void; state: CodecState }): void {
  if (codec.state === 'closed') return;
  try {
    codec.close();
  } catch {
    // Already closing, or never fully configured — nothing to clean up.
  }
}

function createRenditionSink(
  rendition: (typeof ABR_LADDER)[number],
  width: number,
  pipeline: AbrPipelineContext,
): RenditionSink {
  const canvas = new OffscreenCanvas(width, rendition.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`No 2D context available for the ${rendition.label} canvas`);

  // `sink` is referenced by the encoder callbacks below before it's assigned
  // — safe, since those callbacks only run later, once construction (and
  // the assignment) has finished.
  // eslint-disable-next-line prefer-const -- assigned exactly once, but not at declaration (see above)
  let sink: RenditionSink;
  const videoEncoder = new VideoEncoder({
    output: (chunk) => handleRenditionVideoChunk(sink, chunk),
    error: (err) => markSinkBroken(sink, 'video encoder', err),
  });
  const audioEncoder = new AudioEncoder({
    output: (chunk) => handleRenditionAudioChunk(sink, chunk),
    error: (err) => markSinkBroken(sink, 'audio encoder', err),
  });

  sink = {
    rendition,
    width,
    canvas,
    ctx,
    videoEncoder,
    audioEncoder,
    pipeline,
    // fMP4's own video and audio are split into separate fragment streams
    // (see `writeFmp4RenditionSegment`) — named distinctly from '.ts'
    // output's one combined `${label}.m3u8` per rendition, so a video-only
    // playlist doesn't read as if it were the whole rendition.
    playlistName: `${pipeline.segmentPrefix}${pipeline.outputContainer === 'fmp4' ? `video_${rendition.label}` : rendition.label}.m3u8`,
    segmentIndex: 0,
    segmentStartUs: 0,
    videoChunks: [],
    pendingAudioChunks: [],
    durations: [],
    writeQueue: Promise.resolve(),
    broken: false,
    isAudioOwner: false,
  };
  return sink;
}

function handleRenditionVideoChunk(sink: RenditionSink, chunk: EncodedVideoChunk): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const info: EncodedChunkInfo = { data, timestampUs: chunk.timestamp, isKeyframe: chunk.type === 'key' };

  const shouldCut =
    info.isKeyframe &&
    sink.videoChunks.length > 0 &&
    info.timestampUs - sink.segmentStartUs >= ABR_SEGMENT_TARGET_SEC * 1_000_000;

  if (shouldCut) {
    // Snapshot + reset synchronously, in this same callback, so a chunk
    // arriving right after can't leak into the segment being cut here.
    const cut = cutRenditionSegment(sink, info.timestampUs);
    sink.writeQueue = sink.writeQueue.then(() => writeRenditionSegment(sink, cut, false));
  }
  sink.videoChunks.push(info);
}

function handleRenditionAudioChunk(sink: RenditionSink, chunk: EncodedAudioChunk): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  sink.pendingAudioChunks.push({ data, timestampUs: chunk.timestamp, isKeyframe: false });
}

/** Snapshot everything accumulated so far into one segment and reset the
 * sink's accumulators. Video chunks up to (not including) the boundary
 * chunk; audio chunks timestamped before it — mirrors `compute_segments`'
 * video-drives-audio-boundary rule in Rust, just computed from encoder
 * output timing instead of source sample timing. */
function cutRenditionSegment(sink: RenditionSink, boundaryUs: number): CutSegment {
  const videoChunks = sink.videoChunks;
  const split = sink.pendingAudioChunks.findIndex((c) => c.timestampUs >= boundaryUs);
  const audioChunks = split === -1 ? sink.pendingAudioChunks : sink.pendingAudioChunks.slice(0, split);

  const startUs = sink.segmentStartUs;
  sink.videoChunks = [];
  sink.pendingAudioChunks = split === -1 ? [] : sink.pendingAudioChunks.slice(split);
  sink.segmentStartUs = boundaryUs;

  return { videoChunks, audioChunks, startUs, endUs: boundaryUs };
}

async function writeRenditionSegment(sink: RenditionSink, cut: CutSegment, isFinal: boolean): Promise<void> {
  if (cut.videoChunks.length === 0) return;
  if (sink.pipeline.outputContainer === 'fmp4') {
    await writeFmp4RenditionSegment(sink, cut);
    return;
  }

  const videoData = concatChunks(cut.videoChunks);
  const videoMeta = cut.videoChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: c.isKeyframe }));
  // With dub-audio active, this rendition's own audio encoder still ran
  // (simplest to leave it be — the discarded work is small next to the
  // video encode) but its output is dropped here: the shared "aud" group
  // built by buildAudioOnlyRenditions carries audio for every rendition
  // instead of each having its own embedded copy.
  const audioData = sink.pipeline.hasDubAudio ? new Uint8Array(0) : concatChunks(cut.audioChunks);
  const audioMeta = sink.pipeline.hasDubAudio
    ? []
    : cut.audioChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: false }));

  const tsBytes = sink.pipeline.processor.mux_encoded_segment(
    videoData,
    JSON.stringify(videoMeta),
    audioData,
    JSON.stringify(audioMeta),
    sink.pipeline.audioSampleRate,
    sink.pipeline.audioChannels,
  ) as Uint8Array;

  const prefix = sink.pipeline.segmentPrefix;
  const segName = `${prefix}${sink.rendition.label}_${String(sink.segmentIndex).padStart(4, '0')}.ts`;
  await writeOutputFile(sink.pipeline.outputFolderHandle, segName, tsBytes);

  sink.durations.push((cut.endUs - cut.startUs) / 1_000_000);
  sink.segmentIndex++;

  const segmentName = (i: number) => `${prefix}${sink.rendition.label}_${String(i).padStart(4, '0')}.ts`;
  const m3u8 = buildIntermediateM3U8(sink.durations, isFinal, segmentName);
  await writeOutputFile(sink.pipeline.outputFolderHandle, sink.playlistName, m3u8);
}

/** Filenames for adaptive fMP4's own init segments/fragments — shared
 * between `writeFmp4RenditionSegment` (which writes them), the
 * `runAbrWebCodecsWithHandle` return path, and `finalizeAbrFmp4Results`
 * (which both need to reference them again afterward) so the naming only
 * lives in one place. */
function fmp4VideoInitName(prefix: string, label: string): string {
  return `${prefix}init_video_${label}.mp4`;
}
function fmp4AudioInitName(prefix: string): string {
  return `${prefix}init_audio.mp4`;
}
function fmp4VideoFragmentName(prefix: string, label: string, i: number): string {
  return `${prefix}frag_video_${label}_${String(i).padStart(4, '0')}.m4s`;
}
function fmp4AudioFragmentName(prefix: string, i: number): string {
  return `${prefix}frag_audio_${String(i).padStart(4, '0')}.m4s`;
}

/** fMP4 counterpart of the `mux_encoded_segment`/`.ts` branch above — every
 * rendition gets its own fMP4 video fragment stream (`init_video_${label}.mp4`
 * + `frag_video_${label}_NNNN.m4s`), sharing exactly one fMP4 audio fragment
 * stream (`init_audio.mp4` + `frag_audio_NNNN.m4s`) written only by
 * `sink.isAudioOwner`'s own segments — see `AbrPipelineContext.outputContainer`.
 * Each rendition's own init segment is built from its *first* segment's own
 * first keyframe (its SPS/PPS never changes mid-rendition, since the encoder
 * config is fixed for the whole job), so it only needs building once, on
 * `sink.segmentIndex === 0`. No `isFinal` flag needed, unlike the `.ts`
 * branch: `buildFmp4MediaPlaylist` always writes `#EXT-X-ENDLIST`. */
async function writeFmp4RenditionSegment(sink: RenditionSink, cut: CutSegment): Promise<void> {
  const prefix = sink.pipeline.segmentPrefix;
  const label = sink.rendition.label;
  const videoInitName = fmp4VideoInitName(prefix, label);
  const audioInitName = fmp4AudioInitName(prefix);
  const videoFragmentName = (i: number) => fmp4VideoFragmentName(prefix, label, i);
  const audioFragmentName = (i: number) => fmp4AudioFragmentName(prefix, i);

  if (sink.segmentIndex === 0) {
    const firstKeyframe = cut.videoChunks[0].data;
    const initVideo = sink.pipeline.processor.init_segment_video_encoded(sink.width, sink.rendition.height, firstKeyframe) as Uint8Array;
    await writeOutputFile(sink.pipeline.outputFolderHandle, videoInitName, initVideo);
    if (sink.isAudioOwner) {
      const initAudio = sink.pipeline.processor.init_segment_audio_encoded(sink.pipeline.audioSampleRate, sink.pipeline.audioChannels) as Uint8Array;
      await writeOutputFile(sink.pipeline.outputFolderHandle, audioInitName, initAudio);
    }
  }

  const videoData = concatChunks(cut.videoChunks);
  const videoMeta = cut.videoChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: c.isKeyframe }));
  const fragVideo = sink.pipeline.processor.mux_video_fragment_encoded(videoData, JSON.stringify(videoMeta), sink.segmentIndex) as Uint8Array;
  await writeOutputFile(sink.pipeline.outputFolderHandle, videoFragmentName(sink.segmentIndex), fragVideo);

  if (sink.isAudioOwner) {
    const audioData = concatChunks(cut.audioChunks);
    const audioMeta = cut.audioChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: false }));
    const fragAudio = sink.pipeline.processor.mux_audio_fragment_encoded(
      audioData,
      JSON.stringify(audioMeta),
      sink.segmentIndex,
      sink.pipeline.audioSampleRate,
    ) as Uint8Array;
    await writeOutputFile(sink.pipeline.outputFolderHandle, audioFragmentName(sink.segmentIndex), fragAudio);
  }

  sink.durations.push((cut.endUs - cut.startUs) / 1_000_000);
  sink.segmentIndex++;

  const videoPlaylist = buildFmp4MediaPlaylist(sink.durations, videoInitName, videoFragmentName);
  await writeOutputFile(sink.pipeline.outputFolderHandle, sink.playlistName, videoPlaylist);
  if (sink.isAudioOwner) {
    const audioPlaylist = buildFmp4MediaPlaylist(sink.durations, audioInitName, audioFragmentName);
    await writeOutputFile(sink.pipeline.outputFolderHandle, `${prefix}audio.m3u8`, audioPlaylist);
  }
}

/** One source clip (intro, main, or outro) encoded across every selected
 * rendition. `playlistText` is the final, complete variant playlist for
 * this source+rendition alone — already written to
 * `${segmentPrefix}${rendition.label}.m3u8`, and also returned so the
 * caller can splice intro/main/outro together into the canonical
 * `${rendition.label}.m3u8` afterward. */
interface AbrSourceResult {
  rendition: (typeof ABR_LADDER)[number];
  width: number;
  playlistText: string;
}

/**
 * Builds the "Original" audio plus every dub track as audio-only HLS
 * renditions sharing one `#EXT-X-MEDIA:TYPE=AUDIO` group — used identically
 * whether the video came from the fast path or either ABR path. Audio
 * quality doesn't need to scale with video rendition the way video does, so
 * this doesn't run once per rendition: one shared track per language serves
 * every video quality, reusing `remuxDubAudioTrack` (byte-copied when the
 * source is already an MP4-family container, FFmpeg-normalized otherwise —
 * see its own comment) for both the source's own audio and every dub file.
 *
 * `boundaries` must be the *real* cumulative segment end times of whichever
 * video rendition these tracks need to line up with — ABR renditions are
 * cut by forced keyframes at encode time (see `nextForceKeyframeUs` in the
 * WebCodecs path, or FFmpeg's own `-hls_time`), not by a pre-computed list
 * the way the fast path's are, so the caller has to recover them from a
 * produced rendition's own playlist rather than assume a fixed cadence.
 *
 * Returns an error string instead of throwing when a track ends up with
 * fewer segments than the video (same "shorter than main content" problem
 * the UI already rejects up front — this is the ABR paths' second line of
 * defense against a resumed/stale session slipping past that check, mirror
 * of the fast path's same guard in `runWithHandle`).
 */
async function buildAudioOnlyRenditions(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  boundaries: number[],
): Promise<AudioTrackTag[] | { error: string }> {
  const { playlistText: origText, segmentCount: origCount } = await remuxDubAudioTrack(
    session.sourceFilePath,
    ORIGINAL_AUDIO_SEGMENT_PREFIX,
    boundaries,
    outputFolderHandle,
  );
  if (origCount < boundaries.length) {
    return { error: "The main content's own audio ended up with fewer segments than its video — please retry the conversion." };
  }
  await writeOutputFile(outputFolderHandle, ORIGINAL_AUDIO_PLAYLIST, origText);
  const audioTags: AudioTrackTag[] = [{ name: 'Original', language: 'und', playlist: ORIGINAL_AUDIO_PLAYLIST, isDefault: true }];

  for (const track of session.dubAudioTracks ?? []) {
    const segmentPrefix = `dub_${track.language}_`;
    const playlist = `dub_${track.language}.m3u8`;
    const { playlistText, segmentCount } = await remuxDubAudioTrack(track.fileName, segmentPrefix, boundaries, outputFolderHandle);
    if (segmentCount < boundaries.length) {
      return { error: `Dub audio "${track.label}" is shorter than the main content and would produce broken playback — use a dub at least as long.` };
    }
    await writeOutputFile(outputFolderHandle, playlist, playlistText);
    audioTags.push({ name: track.label, language: track.language, playlist, isDefault: false });
  }
  return audioTags;
}

/**
 * Splices intro/outro onto every produced rendition (matched by height) and
 * writes the combined result to each rendition's canonical
 * `${label}.m3u8` — the same filename `buildMasterM3U8` already points
 * to, so the master playlist needs no special-casing for intro/outro.
 * A rendition missing from `introResults`/`outroResults` (that clip failed
 * for just that rendition, or wasn't requested at all) simply splices
 * without it rather than failing the whole rendition.
 */
async function finalizeAbrResults(
  outputFolderHandle: FileSystemDirectoryHandle,
  mainResults: AbrSourceResult[],
  introResults: AbrSourceResult[] | null,
  outroResults: AbrSourceResult[] | null,
  subtitleTags: SubtitleTag[],
  audioTags?: AudioTrackTag[],
): Promise<{ masterM3u8: string; highestM3u8: string }> {
  if (mainResults.length === 0) {
    throw new Error('No rendition produced any output.');
  }

  const streamInfos: { rendition: (typeof ABR_LADDER)[number]; playlist: string; width: number }[] = [];
  let highestM3u8 = '';

  for (const main of mainResults) {
    const intro = introResults?.find((r) => r.rendition.height === main.rendition.height);
    const outro = outroResults?.find((r) => r.rendition.height === main.rendition.height);
    const texts = [intro?.playlistText, main.playlistText, outro?.playlistText].filter(
      (t): t is string => t !== undefined,
    );

    const spliced = texts.length > 1 ? spliceM3U8Texts(texts) : main.playlistText;
    const playlistName = `${main.rendition.label}.m3u8`;
    await writeOutputFile(outputFolderHandle, playlistName, spliced);
    streamInfos.push({ rendition: main.rendition, playlist: playlistName, width: main.width });
    highestM3u8 = spliced;

    // The intro/outro clips' own standalone playlists (e.g.
    // `intro_240p.m3u8`) were only ever a byproduct of encoding them with
    // the same per-source machinery as the main content — nothing
    // references them once their segments are folded into the spliced
    // playlist above, so clean them up rather than leave dead files
    // sitting in the output.
    if (intro) await removeOutputFileQuietly(outputFolderHandle, `intro_${main.rendition.label}.m3u8`);
    if (outro) await removeOutputFileQuietly(outputFolderHandle, `outro_${main.rendition.label}.m3u8`);
  }

  if (subtitleTags.length > 0) {
    const totalDuration = totalDurationFromPlaylist(highestM3u8);
    for (const tag of subtitleTags) {
      await writeOutputFile(outputFolderHandle, tag.playlist, buildSubtitlePlaylist(totalDuration, subtitleVttFilename(tag.language)));
    }
  }

  const masterM3u8 = buildMasterM3U8(streamInfos, subtitleTags, audioTags);
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  return { masterM3u8, highestM3u8 };
}

/** fMP4 counterpart of `finalizeAbrResults`, for adaptive fMP4/DASH output —
 * intentionally narrower in scope, matching `runFmp4FastPath`'s own single-
 * quality scope: no intro/outro splicing, no dub-audio, no subtitles (see
 * the `outputContainer === 'fmp4'` guards in `runTranscoding`), so there's
 * no per-rendition splicing step here, just one master playlist plus one
 * DASH manifest describing the fragments `runAbrWebCodecsWithHandle`
 * already wrote. `results` must include the rendition that ended up as
 * `isAudioOwner` (see its own comment) — without it there's no audio
 * track to point either manifest at, so this throws rather than shipping
 * video-only output silently. */
async function finalizeAbrFmp4Results(
  outputFolderHandle: FileSystemDirectoryHandle,
  results: AbrSourceResult[],
  renditions: (typeof ABR_LADDER)[number][],
  processor: InstanceType<WasmModule['HlsProcessor']>,
): Promise<{ masterM3u8: string; highestM3u8: string }> {
  if (results.length === 0) {
    throw new Error('No rendition produced any output.');
  }

  const audioOwnerRendition = renditions.reduce((best, r) => (r.audioBitrateKbps > best.audioBitrateKbps ? r : best));
  const audioResult = results.find((r) => r.rendition.label === audioOwnerRendition.label);
  if (!audioResult) {
    throw new Error(`${audioOwnerRendition.label} (the rendition carrying the shared audio track) failed to produce any output — no valid audio track exists to ship.`);
  }

  const streamInfos = results.map((r) => ({ rendition: r.rendition, playlist: `video_${r.rendition.label}.m3u8`, width: r.width }));
  const masterM3u8 = buildFmp4MultiRenditionMasterM3U8(streamInfos, 'audio.m3u8');
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  const codecConfig = JSON.parse(processor.codec_config() as unknown as string) as CodecConfig;
  const videoRepresentations: DashRendition[] = results.map((r) => ({
    id: `video_${r.rendition.label}`,
    mimeType: 'video/mp4',
    codecs: codecConfig.videoCodec,
    bandwidth: r.rendition.videoBitrateKbps * 1000,
    width: r.width,
    height: r.rendition.height,
    initFilename: fmp4VideoInitName('', r.rendition.label),
    segmentDurationsSec: durationsFromPlaylist(r.playlistText),
    mediaTemplate: `frag_video_${r.rendition.label}_$Number%04d$.m4s`,
  }));
  const audioDurations = durationsFromPlaylist(audioResult.playlistText);
  const audioRepresentation: DashRendition = {
    id: 'audio',
    mimeType: 'audio/mp4',
    codecs: codecConfig.audioCodec,
    bandwidth: audioOwnerRendition.audioBitrateKbps * 1000,
    audioSamplingRate: codecConfig.audioSampleRate,
    initFilename: fmp4AudioInitName(''),
    segmentDurationsSec: audioDurations,
    mediaTemplate: 'frag_audio_$Number%04d$.m4s',
  };

  try {
    const totalDuration = audioDurations.reduce((a, b) => a + b, 0);
    const dashManifest = buildDashManifest(totalDuration, [...videoRepresentations, audioRepresentation]);
    await writeOutputFile(outputFolderHandle, 'manifest.mpd', dashManifest);
  } catch (err) {
    // Non-fatal — see the same tolerance in runFmp4FastPath.
    log(`Could not build the DASH manifest: ${err}`, 'ERROR');
  }

  // Matches `finalizeAbrResults`' own `highestM3u8` semantics: whichever
  // rendition's own text was produced last, which is the highest quality
  // one, since callers always pass `results` sorted ascending by height.
  return { masterM3u8, highestM3u8: results[results.length - 1].playlistText };
}

/** Adaptive-HLS hardware entry point: encodes the main content across every
 * selected rendition and, when present, intro/outro clips too (each
 * independently — see `runAbrEncodeForSource`), then splices them together
 * per rendition. An intro/outro that fails to encode is logged and skipped
 * rather than failing the whole job, matching how a single broken
 * rendition is already handled inside `runAbrWebCodecsWithHandle`. */
async function runAbrTranscodingWebCodecs(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
  subtitleTags: SubtitleTag[],
): Promise<void> {
  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
  const introName = session.introOutro?.introFileName;
  const outroName = session.introOutro?.outroFileName;
  // Mutually exclusive with intro/outro (checked in runTranscoding before
  // this ever runs), so introName/outroName are never both set alongside
  // this — no special-casing needed for that combination here.
  const hasDubAudio = !!session.dubAudioTracks?.length;

  const opfsRoot = await navigator.storage.getDirectory();

  let introResults: AbrSourceResult[] | null = null;
  if (introName) {
    let resolvedIntroName: string | undefined;
    try {
      resolvedIntroName = await resolveIntroOutroClip(
        introName, session.introOutro?.introIsImage, session.introOutro?.introDuration, sourceWidth, sourceHeight,
      );
      introResults = await runAbrEncodeForSource(resolvedIntroName, outputFolderHandle, renditions, sourceWidth, sourceHeight, 'intro_', false);
    } catch (err) {
      if (cancelled) return;
      log(`Could not encode the intro (${err}) — continuing without it.`, 'ERROR');
    } finally {
      if (resolvedIntroName && resolvedIntroName !== introName) await removeOutputFileQuietly(opfsRoot, resolvedIntroName);
    }
  }
  if (cancelled) return;

  const mainResults = await runAbrEncodeForSource(session.sourceFilePath, outputFolderHandle, renditions, sourceWidth, sourceHeight, '', hasDubAudio);
  if (cancelled) return;

  let outroResults: AbrSourceResult[] | null = null;
  if (outroName) {
    let resolvedOutroName: string | undefined;
    try {
      resolvedOutroName = await resolveIntroOutroClip(
        outroName, session.introOutro?.outroIsImage, session.introOutro?.outroDuration, sourceWidth, sourceHeight,
      );
      outroResults = await runAbrEncodeForSource(resolvedOutroName, outputFolderHandle, renditions, sourceWidth, sourceHeight, 'outro_', false);
    } catch (err) {
      if (cancelled) return;
      log(`Could not encode the outro (${err}) — continuing without it.`, 'ERROR');
    } finally {
      if (resolvedOutroName && resolvedOutroName !== outroName) await removeOutputFileQuietly(opfsRoot, resolvedOutroName);
    }
  }
  if (cancelled) return;

  let audioTags: AudioTrackTag[] | undefined;
  if (hasDubAudio) {
    if (mainResults.length === 0) {
      post({ type: 'ERROR', error: 'No rendition produced any output.' });
      return;
    }
    // Any produced rendition's real cut points work — they're all forced to
    // the same keyframe schedule (see nextForceKeyframeUs in
    // runAbrWebCodecsWithHandle), so they agree on where each segment ends.
    const boundaries = cumulativeBoundaries(durationsFromPlaylist(mainResults[0].playlistText));
    const result = await buildAudioOnlyRenditions(session, outputFolderHandle, boundaries);
    if ('error' in result) {
      post({ type: 'ERROR', error: result.error });
      return;
    }
    audioTags = result;
  }

  const { masterM3u8, highestM3u8 } = await finalizeAbrResults(outputFolderHandle, mainResults, introResults, outroResults, subtitleTags, audioTags);
  post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
}

/** Adaptive fMP4/DASH hardware entry point — narrower in scope than
 * `runAbrTranscodingWebCodecs`: no intro/outro, no dub-audio, no subtitles
 * (all rejected up front by `runTranscoding`'s own `outputContainer ===
 * 'fmp4'` guard, matching `runFmp4FastPath`'s single-quality scope), and no
 * FFmpeg fallback either — the FFmpeg ABR path only ever produces MPEG-TS,
 * so there's nothing for it to fall back to for a container the user
 * explicitly asked for (`runAdaptiveHls`'s own FFmpeg fallback is only
 * reachable for '.ts' output, see the dispatch in `runTranscoding`). Just a
 * thin wrapper around `runAbrEncodeForSource`: `runAbrWebCodecsWithHandle`
 * already does its own finalizing (master playlist + DASH manifest) and
 * posts `COMPLETE` itself once `outputContainer === 'fmp4'`, since — unlike
 * the '.ts' path — there's no intro/outro splicing step left to do
 * afterward here. */
async function runAbrTranscodingWebCodecsFmp4(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
): Promise<void> {
  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
  await runAbrEncodeForSource(session.sourceFilePath, outputFolderHandle, renditions, sourceWidth, sourceHeight, '', false, 'fmp4');
}

/** Runs the hardware WebCodecs ABR pipeline for one OPFS-resident source
 * clip. Used for the main content (`segmentPrefix: ''`) and, when present,
 * for intro/outro clips (`segmentPrefix: 'intro_'`/`'outro_'`) — each call
 * is fully independent, so one clip's trouble can be caught and skipped by
 * the caller without affecting the others. */
async function runAbrEncodeForSource(
  opfsFileName: string,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
  sourceWidth: number,
  sourceHeight: number,
  segmentPrefix: string,
  hasDubAudio: boolean,
  outputContainer: 'ts' | 'fmp4' = 'ts',
): Promise<AbrSourceResult[]> {
  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(opfsFileName);
  const syncHandle = await fileHandle.createSyncAccessHandle();
  try {
    return await runAbrWebCodecsWithHandle(syncHandle, outputFolderHandle, renditions, sourceWidth, sourceHeight, segmentPrefix, hasDubAudio, outputContainer);
  } finally {
    syncHandle.close();
  }
}

async function runAbrWebCodecsWithHandle(
  syncHandle: FileSystemSyncAccessHandle,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
  sourceWidth: number,
  sourceHeight: number,
  segmentPrefix: string,
  hasDubAudio: boolean,
  outputContainer: 'ts' | 'fmp4' = 'ts',
): Promise<AbrSourceResult[]> {
  const renditionLabels = renditions.map((r) => r.label).join(', ');
  const logPrefix = segmentPrefix ? `[${segmentPrefix.replace(/_$/, '')}] ` : '';
  log(`${logPrefix}Encoding ${renditions.length} rendition${renditions.length > 1 ? 's' : ''} with hardware acceleration: ${renditionLabels}…`);

  const fileSize = syncHandle.getSize();
  const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
  const headerBuf = readAt(syncHandle, 0, HEADER_READ);

  const { HlsProcessor } = await loadWasm();
  const processor = new HlsProcessor();
  processor.set_target_duration(ABR_SEGMENT_TARGET_SEC);

  let parseResult: ParseHeadersResult;
  try {
    const jsonStr = processor.parse_headers(headerBuf) as unknown as string;
    parseResult = JSON.parse(jsonStr) as ParseHeadersResult;
  } catch {
    const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
    const tailBuf = readAt(syncHandle, tailOffset, fileSize - tailOffset);
    const jsonStr = processor.parse_headers(tailBuf) as unknown as string;
    parseResult = JSON.parse(jsonStr) as ParseHeadersResult;
  }

  const codecConfig = JSON.parse(processor.codec_config() as unknown as string) as CodecConfig;

  // `parse_headers` groups samples into `ABR_SEGMENT_TARGET_SEC`-long
  // segments for the fast path; ABR decodes the whole file in one pass, so
  // flatten them back into one continuous, ordered stream per track.
  const videoSamples = parseResult.segments.flatMap((s) => s.videoSamples);
  const audioSamples = parseResult.segments.flatMap((s) => s.audioSamples);
  if (videoSamples.length === 0) {
    throw new Error('No video samples found');
  }

  // Only ever set by the *decoders* — a shared-infrastructure failure that
  // genuinely can affect every rendition, unlike an individual encoder
  // failing (see `RenditionSink.broken`, which handles that per-rendition
  // instead of through here).
  let decodeFailed: unknown = null;

  const pipeline: AbrPipelineContext = {
    outputFolderHandle,
    processor,
    audioSampleRate: codecConfig.audioSampleRate,
    audioChannels: codecConfig.audioChannels,
    segmentPrefix,
    hasDubAudio,
    outputContainer,
  };

  const sinks = renditions.map((r) =>
    createRenditionSink(r, computeRenditionWidth(sourceWidth, sourceHeight, r.height), pipeline),
  );

  if (outputContainer === 'fmp4') {
    // The highest-bitrate selected rendition's own audio encode becomes the
    // one shared fMP4 audio stream every rendition's playlist points at (see
    // `AbrPipelineContext.outputContainer`) — the best quality available
    // among renditions actually being produced, not a fixed rung that might
    // not even be selected.
    const owner = sinks.reduce((best, s) => (s.rendition.audioBitrateKbps > best.rendition.audioBitrateKbps ? s : best));
    owner.isAudioOwner = true;
  }

  for (const sink of sinks) {
    sink.videoEncoder.configure({
      codec: ABR_ENCODE_VIDEO_CODEC,
      width: sink.width,
      height: sink.rendition.height,
      bitrate: sink.rendition.videoBitrateKbps * 1000,
      avc: { format: 'annexb' },
    });
    sink.audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: codecConfig.audioSampleRate,
      numberOfChannels: codecConfig.audioChannels,
      bitrate: sink.rendition.audioBitrateKbps * 1000,
    });
  }

  // Governs the *decode* feed loops only: a shared-infrastructure problem
  // (cancelled, or the decoder itself failed) or every rendition already
  // being broken — nothing left that could use more decoded data either way.
  const isDecodeAborted = () => cancelled || decodeFailed !== null || sinks.every((s) => s.broken);

  // Force a keyframe on every rendition at the same source timestamps, so
  // renditions stay segment-aligned for clean playlist switching.
  let nextForceKeyframeUs = 0;
  // Decoded frames are handled through this chain (not fired independently)
  // so scaling + `encode()` calls always happen in presentation order, even
  // though the decoder's `output` callback can fire faster than one frame's
  // handling (including its encoder-backpressure waits) can complete.
  let frameQueue: Promise<void> = Promise.resolve();
  // How many decoded frames have been handed to `handleDecodedFrame` but
  // haven't finished being scaled + encoded for every rendition yet. The
  // decoder's own `decodeQueueSize` only bounds *its* internal backlog, not
  // ours — decode is hardware-fast, so without this the feed loop below
  // could keep decoding thousands of frames ahead of a slower encode stage,
  // each one held in memory until `handleDecodedFrame` finally reaches it.
  let pendingFrames = 0;
  const MAX_PENDING_FRAMES = 6;
  const MAX_CODEC_QUEUE = 8;

  // Audio needs the exact same treatment as video above, for the exact same
  // reason: decode is fast and the feed loop below has no idea how far
  // behind a slower encode stage is unless something tells it. Audio chunks
  // are far cheaper than video frames, so the queue can run deeper before
  // it's worth throttling.
  let audioFrameQueue: Promise<void> = Promise.resolve();
  let pendingAudioChunks = 0;
  const MAX_PENDING_AUDIO_CHUNKS = 30;

  const handleDecodedAudio = async (data: AudioData): Promise<void> => {
    try {
      for (const sink of sinks) {
        if (sink.broken) continue;
        await waitUntilBelow(() => sink.audioEncoder.encodeQueueSize, MAX_CODEC_QUEUE, () => cancelled);
        // `state` can flip to 'closed' between this check and the `encode()`
        // call below (e.g. a hardware session failure took this encoder
        // down on its own) — the try/catch is the backstop for that race.
        if (cancelled || sink.audioEncoder.state !== 'configured') continue;
        try {
          sink.audioEncoder.encode(data);
        } catch (err) {
          markSinkBroken(sink, 'audio encoder', err);
        }
      }
    } finally {
      data.close();
    }
  };

  const handleDecodedFrame = async (frame: VideoFrame): Promise<void> => {
    const forceKey = frame.timestamp >= nextForceKeyframeUs;
    if (forceKey) nextForceKeyframeUs = frame.timestamp + ABR_SEGMENT_TARGET_SEC * 1_000_000;

    const scaled = sinks.map((sink) => {
      // Black-fill first: the letterbox/pillarbox rect below only covers
      // part of the canvas whenever the frame's own aspect ratio doesn't
      // exactly match this sink's — the rest needs to stay black, not
      // whatever pixels a previous frame left behind.
      sink.ctx.fillStyle = 'black';
      sink.ctx.fillRect(0, 0, sink.width, sink.rendition.height);
      const rect = computeLetterboxRect(frame.displayWidth, frame.displayHeight, sink.width, sink.rendition.height);
      sink.ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h);
      return new VideoFrame(sink.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    });
    frame.close();

    for (let i = 0; i < sinks.length; i++) {
      if (sinks[i].broken) {
        scaled[i].close();
        continue;
      }
      await waitUntilBelow(() => sinks[i].videoEncoder.encodeQueueSize, MAX_CODEC_QUEUE, () => cancelled);
      if (cancelled || sinks[i].videoEncoder.state !== 'configured') {
        scaled[i].close();
        continue;
      }
      try {
        sinks[i].videoEncoder.encode(scaled[i], { keyFrame: forceKey });
      } catch (err) {
        markSinkBroken(sinks[i], 'video encoder', err);
        scaled[i].close();
        continue;
      }
      scaled[i].close();
    }
  };

  // Tracked so a decode error (a generic "Decoding error." from Chrome, with
  // no further detail) can at least be reported against the sample that
  // most likely triggered it — decode errors surface asynchronously, after
  // the feed loop has usually already moved on to later samples.
  let lastFedVideo: { index: number; timestampUs: number; isKeyframe: boolean } | null = null;
  let lastFedAudioIndex = -1;

  const videoDecoder = new VideoDecoder({
    output: (frame) => {
      pendingFrames++;
      frameQueue = frameQueue.then(() => handleDecodedFrame(frame)).finally(() => {
        pendingFrames--;
      });
    },
    error: (err) => {
      const at = lastFedVideo
        ? `near video sample ${lastFedVideo.index}/${videoSamples.length} (t=${(lastFedVideo.timestampUs / 1e6).toFixed(2)}s, keyframe=${lastFedVideo.isKeyframe})`
        : 'before any sample was fed';
      decodeFailed ??= new Error(`Video decode error ${at}: ${err}`);
    },
  });
  videoDecoder.configure({
    codec: codecConfig.videoCodec,
    description: new Uint8Array(codecConfig.videoDescriptionBytes),
  });

  const audioDecoder = new AudioDecoder({
    output: (data) => {
      pendingAudioChunks++;
      audioFrameQueue = audioFrameQueue.then(() => handleDecodedAudio(data)).finally(() => {
        pendingAudioChunks--;
      });
    },
    error: (err) => {
      const at = lastFedAudioIndex >= 0 ? `near audio sample ${lastFedAudioIndex}/${audioSamples.length}` : 'before any sample was fed';
      decodeFailed ??= new Error(`Audio decode error ${at}: ${err}`);
    },
  });
  audioDecoder.configure({
    codec: codecConfig.audioCodec,
    sampleRate: codecConfig.audioSampleRate,
    numberOfChannels: codecConfig.audioChannels,
    description: new Uint8Array(codecConfig.audioDescriptionBytes),
  });

  // From here on, every exit path (cancel, error, or success) must close
  // every codec — otherwise a failed hardware-path attempt would leak
  // decoder/encoder resources right before falling back to FFmpeg.wasm.
  try {
    const videoTimescale = parseResult.videoTimescale;
    const audioTimescale = parseResult.audioTimescale;
    const lastVideoSample = videoSamples[videoSamples.length - 1];
    const totalDurationSec = (lastVideoSample.dts + lastVideoSample.duration) / videoTimescale;

    // Video and audio are fed *interleaved*, in chronological order — not
    // "all of video, then all of audio". Segments are cut and written
    // incrementally as each rendition's video encoder crosses a keyframe
    // boundary (see `handleRenditionVideoChunk`), folding in whatever audio
    // has accumulated in `pendingAudioChunks` *so far*. Feeding all of video
    // first would mean every cut happens before any audio sample has reached
    // the decoder, so every segment but the last gets muxed with zero audio.
    let videoIdx = 0;
    let audioIdx = 0;
    while (videoIdx < videoSamples.length || audioIdx < audioSamples.length) {
      if (isDecodeAborted()) break;

      const nextVideoSec = videoIdx < videoSamples.length ? videoSamples[videoIdx].dts / videoTimescale : Infinity;
      const nextAudioSec = audioIdx < audioSamples.length ? audioSamples[audioIdx].dts / audioTimescale : Infinity;

      if (nextVideoSec <= nextAudioSec) {
        await waitUntilBelow(() => videoDecoder.decodeQueueSize, MAX_CODEC_QUEUE, isDecodeAborted);
        await waitUntilBelow(() => pendingFrames, MAX_PENDING_FRAMES, isDecodeAborted);
        if (isDecodeAborted()) break;

        const s = videoSamples[videoIdx];
        // Fed as-is (AVCC length-prefixed, matching how mux_segment reads
        // it) — `description` above already carries the SPS/PPS, so no
        // Annex-B conversion is needed here.
        const raw = readAt(syncHandle, s.fileOffset, s.size);
        const timestampUs = Math.round((s.pts / videoTimescale) * 1_000_000);

        lastFedVideo = { index: videoIdx, timestampUs, isKeyframe: s.isKeyframe };
        videoDecoder.decode(
          new EncodedVideoChunk({ type: s.isKeyframe ? 'key' : 'delta', timestamp: timestampUs, data: raw }),
        );

        if (videoIdx % 15 === 0 && totalDurationSec > 0) {
          const pct = Math.min(Math.round((s.dts / videoTimescale / totalDurationSec) * 85), 85);
          post({ type: 'CONVERTING', log: `${logPrefix}Decoding and encoding… ${pct}%`, convertProgress: pct, renditionLabel: renditionLabels });
        }
        videoIdx++;
      } else {
        // Raw AAC samples decode directly (no Annex-B-style conversion
        // needed — MP4 already stores AAC frames unwrapped, see
        // `mux_segment_inner`'s audio loop for the same assumption on the
        // muxing side). Backpressured the same way video is above.
        await waitUntilBelow(() => audioDecoder.decodeQueueSize, MAX_CODEC_QUEUE, isDecodeAborted);
        await waitUntilBelow(() => pendingAudioChunks, MAX_PENDING_AUDIO_CHUNKS, isDecodeAborted);
        if (isDecodeAborted()) break;

        const s = audioSamples[audioIdx];
        const raw = readAt(syncHandle, s.fileOffset, s.size);
        const timestampUs = Math.round((s.pts / audioTimescale) * 1_000_000);
        lastFedAudioIndex = audioIdx;
        audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestampUs, data: raw }));
        audioIdx++;
      }
    }

    if (cancelled) {
      log('Cancelled.');
      return [];
    }
    // Not checking `decodeFailed` here on purpose: it's set asynchronously by
    // the decoder's `error` callback, and `decode()` doesn't wait for that,
    // so right after the loop above there's no reliable way to tell a
    // "no error yet" gap from a "the last sample's error just hasn't
    // surfaced yet" race. The flush() below is the first point that
    // actually waits for every submitted decode to finish, so error
    // handling — including the tolerance for a bad tail frame, next — all
    // happens there instead.

    // A handful of real-world files have a truncated or otherwise unusual
    // final frame — decode fails on literally the last sample or two, after
    // everything before it decoded fine. Throwing the whole job away over a
    // few milliseconds of trailing video isn't worth it: tolerate a decode
    // error there and finish with what's already been decoded/encoded,
    // instead of falling back to FFmpeg and restarting from scratch.
    const isNearEndOfVideo = () =>
      lastFedVideo !== null &&
      (videoSamples.length - 1 - lastFedVideo.index <= 5 || totalDurationSec - lastFedVideo.timestampUs / 1e6 <= 2);

    try {
      await videoDecoder.flush();
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return [];
      }
      if (!isNearEndOfVideo()) throw decodeFailed ?? err;
      log(
        `Hardware decode hit an error on the last stretch of video (sample ${lastFedVideo!.index}/${videoSamples.length}, t=${(lastFedVideo!.timestampUs / 1e6).toFixed(2)}s) — finishing without it rather than restarting the whole job.`,
        'ERROR',
      );
      decodeFailed = null;
    }

    // `flush()` rejects with the codec's own bare DOMException the instant a
    // decode error happens — often before the `error` callback above has had
    // a chance to run, so it can reach here first and race past the richer
    // `decodeFailed` it was about to set. Prefer `decodeFailed` whenever it's
    // available; only fall back to the raw rejection if it somehow isn't. By
    // this point every sample has already been fed, so any trouble draining
    // what's left is inherently "the last stretch" — always tolerated.
    try {
      await frameQueue;
      await audioDecoder.flush();
      await audioFrameQueue;
    } catch (err) {
      log(`Hardware pipeline hit more trouble finishing the last stretch (${decodeFailed ?? err}) — continuing with what's already decoded.`, 'ERROR');
      decodeFailed = null;
    }

    post({ type: 'CONVERTING', log: `${logPrefix}Finalizing renditions…`, convertProgress: 90, renditionLabel: renditionLabels });

    // Every sample has already been submitted for encoding by this point —
    // flush() just drains whatever's still queued per rendition. A rejection
    // here just marks that one rendition broken, same as an `encode()`
    // failure earlier would have — it doesn't touch the others, and skips
    // ones already known broken rather than flushing them pointlessly.
    const videoFlushResults = await Promise.allSettled(
      sinks.map((s) => (s.broken ? Promise.resolve() : s.videoEncoder.flush())),
    );
    const audioFlushResults = await Promise.allSettled(
      sinks.map((s) => (s.broken ? Promise.resolve() : s.audioEncoder.flush())),
    );
    videoFlushResults.forEach((result, i) => {
      if (result.status === 'rejected') markSinkBroken(sinks[i], 'video encoder', result.reason);
    });
    audioFlushResults.forEach((result, i) => {
      if (result.status === 'rejected') markSinkBroken(sinks[i], 'audio encoder', result.reason);
    });

    for (const sink of sinks) {
      if (sink.videoChunks.length > 0) {
        const lastUs = sink.videoChunks[sink.videoChunks.length - 1].timestampUs;
        const cut = cutRenditionSegment(sink, lastUs + 1);
        // Anything left over is trailing audio past the last video chunk —
        // fold it into the final segment rather than dropping it.
        cut.audioChunks = cut.audioChunks.concat(sink.pendingAudioChunks);
        sink.pendingAudioChunks = [];
        sink.writeQueue = sink.writeQueue.then(() => writeRenditionSegment(sink, cut, true));
      }
      await sink.writeQueue;

      if (sink.durations.length > 0) {
        post({ type: 'SEGMENT_DONE', log: `${sink.rendition.label} done (${sink.segmentIndex} segments)`, convertProgress: 100 });
      } else {
        log(`${sink.rendition.label}: no segments were produced (it failed before encoding anything) — leaving it out of master.m3u8.`, 'ERROR');
      }
    }

    // A rendition that failed early enough to produce zero segments (rare —
    // the tolerance above is for trouble on the last stretch of an
    // otherwise-successful run) has no `.m3u8` file to point to, so it's
    // left out of the results the caller splices/builds a master from,
    // rather than referencing a file that doesn't exist.
    const producedSinks = sinks.filter((s) => s.durations.length > 0);

    if (outputContainer === 'fmp4') {
      const results = producedSinks.map((s) => ({
        rendition: s.rendition,
        width: s.width,
        playlistText: buildFmp4MediaPlaylist(s.durations, fmp4VideoInitName(segmentPrefix, s.rendition.label), (i) =>
          fmp4VideoFragmentName(segmentPrefix, s.rendition.label, i),
        ),
      }));
      // Scoped to the main content only (see `runAbrTranscodingWebCodecsFmp4`
      // — fMP4/DASH ABR has no intro/outro to splice, unlike the '.ts'
      // branch below), so this is always the whole job's own final result:
      // safe to build and write the master playlist + DASH manifest right
      // here, using the `processor`/`codecConfig` already parsed above
      // rather than re-parsing the source a second time just for this.
      const { masterM3u8, highestM3u8 } = await finalizeAbrFmp4Results(outputFolderHandle, results, renditions, processor);
      post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
      return results;
    }

    return producedSinks.map((s) => ({
      rendition: s.rendition,
      width: s.width,
      playlistText: buildIntermediateM3U8(s.durations, true, (i) => `${segmentPrefix}${s.rendition.label}_${String(i).padStart(4, '0')}.ts`),
    }));
  } finally {
    closeQuietly(videoDecoder);
    closeQuietly(audioDecoder);
    for (const sink of sinks) {
      closeQuietly(sink.videoEncoder);
      closeQuietly(sink.audioEncoder);
    }
  }
}

/** Adaptive HLS entry point: use hardware WebCodecs encoding when the
 * browser and selected renditions support it, otherwise fall back to the
 * FFmpeg.wasm path below — which stays in the file anyway for non-native
 * container conversion, so keeping it as an ABR safety net adds no new
 * dependency. */
async function runAdaptiveHls(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  subtitleTags: SubtitleTag[],
): Promise<void> {
  const heights = [...(session.abrHeights ?? [])].sort((a, b) => a - b);
  if (heights.length === 0) {
    post({ type: 'ERROR', error: 'No renditions selected for the adaptive playlist.' });
    return;
  }
  const renditions = heights
    .map((h) => ABR_LADDER.find((r) => r.height === h))
    .filter((r): r is (typeof ABR_LADDER)[number] => r !== undefined);

  const canUseHardware = await canUseWebCodecsAbr(renditions, session.sourceWidth ?? 0, session.sourceHeight ?? 0);

  if (canUseHardware) {
    try {
      await runAbrTranscodingWebCodecs(session, outputFolderHandle, renditions, subtitleTags);
      return;
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      log(`Hardware-accelerated encoding failed (${err}), falling back to FFmpeg…`, 'ERROR');
    }
  } else {
    log('Hardware-accelerated encoding is not available here — using FFmpeg instead.');
  }

  await runAbrTranscoding(session, outputFolderHandle, subtitleTags);
}

// ── Helpers ──────────────────────────────────────────────────────

function post(event: WorkerEvent) {
  self.postMessage(event);
}

/**
 * `level: 'ERROR'` here means "show this red in the log console" — a
 * recoverable fallback worth flagging (hardware→FFmpeg, one rendition
 * dropped, "continuing without X") — NOT "the job has failed". It always
 * posts as a plain `PROGRESS` event, never `ERROR`, so it can't flip
 * useTranscoder's status away from 'processing'/'converting' out from
 * under a job that's still running, possibly to a real, correct
 * completion. A genuinely fatal failure posts `{ type: 'ERROR', error }`
 * directly instead (see every `return` after one in this file) — that's
 * the only thing that should ever set the job itself to failed.
 *
 * Before this split, every one of those recoverable-fallback messages —
 * despite each explicitly saying "continuing"/"falling back"/"retrying" —
 * showed "Something went wrong" in the export UI immediately, even on a
 * job that then finished successfully seconds later: confirmed with a real
 * intro clip whose audio sample rate WebCodecs' AAC encoder rejected,
 * where the FFmpeg fallback the log already announced went on to complete
 * the whole export, well after the UI had already given up on it.
 */
function log(msg: string, level: 'PROGRESS' | 'ERROR' = 'PROGRESS') {
  post({ type: 'PROGRESS', log: msg, logLevel: level === 'ERROR' ? 'error' : 'info' });
}

function readAt(handle: FileSystemSyncAccessHandle, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  const read = handle.read(buf, { at: offset });
  return buf.subarray(0, read);
}

function readSamples(
  handle: FileSystemSyncAccessHandle,
  samples: SegmentInfoJs['videoSamples'],
): Uint8Array {
  let total = 0;
  for (const s of samples) total += s.size;

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const s of samples) {
    const chunk = readAt(handle, s.fileOffset, s.size);
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Write a file into the output directory, overwriting it if it already exists. */
async function writeOutputFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  data: Uint8Array | string,
): Promise<void> {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  const payload: ArrayBuffer | string =
    typeof data === 'string' ? data : (new Uint8Array(data).buffer.slice(0) as ArrayBuffer);
  await writable.write(payload);
  await writable.close();
}

/** Reads a previously-written output file back as text, or `null` if it
 * doesn't exist — used by a RESUME job to recover state (e.g. pre-pause
 * segment durations, see `runWithHandle`) from what's already on disk
 * rather than from React-side session state, which never actually tracked
 * it (see the removed `TranscodingSession.segmentDurations` field). */
async function readOutputFileText(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<string | null> {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    return await (await fh.getFile()).text();
  } catch {
    return null;
  }
}

async function removeOutputFileQuietly(dirHandle: FileSystemDirectoryHandle, filename: string): Promise<void> {
  try {
    await dirHandle.removeEntry(filename);
  } catch {
    // Never existed, or already gone — fine either way.
  }
}

// ── Message handling ─────────────────────────────────────────────

let paused = false;
let cancelled = false;
/** Set while an ABR job's FFmpeg instances are running, so CANCEL can abort them mid-flight. */
let abrAbortController: AbortController | null = null;

self.addEventListener('message', async (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;

  if (cmd.type === 'PAUSE') {
    paused = true;
    post({ type: 'PAUSED', log: 'Paused.' });
    return;
  }

  if (cmd.type === 'CANCEL') {
    cancelled = true;
    abrAbortController?.abort();
    return;
  }

  if (cmd.type === 'START' || cmd.type === 'RESUME') {
    paused = false;
    cancelled = false;
    await runTranscoding(cmd);
  }
});

/**
 * Cheap upfront check for the fast (Rust remux) path only: a native
 * extension (.mp4/.mov/...) doesn't guarantee a compatible video codec. An
 * iPhone's "High Efficiency" recording mode writes HEVC into a .mov/.mp4
 * container — same extension as H.264, incompatible bitstream. Left
 * undetected pre-HEVC-support, the fast path didn't error, it copied the
 * (wrong) codec's samples through as-is and reported success on an
 * undecodable segment; see `UNSUPPORTED_VIDEO_CODEC` in wasm/src/lib.rs's
 * parse_headers for the actual gate. Only that specific signal routes to
 * "needs conversion" from a genuine parse failure — any other kind is left
 * for the real run to hit and report normally, so a genuinely malformed
 * file doesn't get a misleading "needs conversion" detour before failing
 * anyway.
 *
 * The Rust fast path can now byte-copy HEVC too (see wasm/src/hevc.rs), but
 * only into MPEG-TS output — fMP4's sample-entry/config-record writer is
 * still AVC-only, so an HEVC source still needs the FFmpeg pre-conversion
 * when `outputContainer === 'fmp4'` specifically, even though `parse_headers`
 * itself now succeeds either way.
 */
async function needsConversionForUnsupportedCodec(sourceOpfsName: string, outputContainer: 'ts' | 'fmp4'): Promise<boolean> {
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    const fileHandle = await opfsRoot.getFileHandle(sourceOpfsName);
    const syncHandle = await fileHandle.createSyncAccessHandle();
    try {
      const fileSize = syncHandle.getSize();
      const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
      const { HlsProcessor } = await loadWasm();
      const probe = new HlsProcessor();
      const isUnsupportedCodecError = (err: unknown) => String(err).includes('UNSUPPORTED_VIDEO_CODEC');
      const stillNeedsConversion = (jsonStr: string) => (JSON.parse(jsonStr) as ParseHeadersResult).videoCodec === 'hevc' && outputContainer === 'fmp4';

      try {
        const jsonStr = probe.parse_headers(readAt(syncHandle, 0, HEADER_READ)) as unknown as string;
        return stillNeedsConversion(jsonStr);
      } catch (err) {
        if (isUnsupportedCodecError(err)) return true;
        try {
          const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
          const jsonStr = probe.parse_headers(readAt(syncHandle, tailOffset, fileSize - tailOffset)) as unknown as string;
          return stillNeedsConversion(jsonStr);
        } catch (err2) {
          return isUnsupportedCodecError(err2);
        }
      }
    } finally {
      syncHandle.close();
    }
  } catch {
    // Can't even open/read the file here -- let the real run surface that
    // error properly instead of masking it behind a wrong verdict.
    return false;
  }
}

/**
 * A real user-picked folder (`outputMode: 'folder'`) has to arrive via
 * postMessage — there's no other way for the worker to get at a handle
 * backed by a one-time user permission grant made on the main thread.
 * OPFS-mode's handle, by contrast, arrives as `null` on purpose (see
 * useTranscoder's start/resume): WebKit can't structured-clone a
 * FileSystemDirectoryHandle across postMessage at all — confirmed
 * empirically (`DataCloneError: The object can not be cloned`), even for
 * one sourced from OPFS itself, even though Chromium has no such
 * restriction. So instead of receiving it, the worker resolves the
 * identical `output_${session.id}` directory itself — navigator.storage is
 * available in a worker too, and this mirrors useTranscoder's own
 * OPFS-directory-resolving effect exactly.
 */
async function resolveOutputFolderHandle(cmd: WorkerCommand): Promise<FileSystemDirectoryHandle | null> {
  if (cmd.outputFolderHandle) return cmd.outputFolderHandle;
  if (cmd.session.outputFolderHandle) return cmd.session.outputFolderHandle;
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    return await opfsRoot.getDirectoryHandle(`output_${cmd.session.id}`, { create: true });
  } catch {
    return null;
  }
}

async function runTranscoding(cmd: WorkerCommand): Promise<void> {
  let { session } = cmd;
  const outputFolderHandle = await resolveOutputFolderHandle(cmd);

  if (!outputFolderHandle) {
    post({ type: 'ERROR', error: 'No output folder selected.' });
    return;
  }

  // Runs before anything else touches the source — every downstream path
  // (fast remux, ABR, segmented) reads session.sourceFilePath, so doing
  // this once here up front reaches all of them with no path-specific
  // wiring. Re-derives a fresh normalized copy on every call, including a
  // RESUME, the same way the non-native-container conversion below already
  // does — session state round-tripped through React/IndexedDB never
  // tracks a worker-local path swap like this (see runWithHandle's own
  // durationsFromPlaylist recovery for the same reason). sourceFileName is
  // also updated to a plain ".mp4" name so the native-container check below
  // doesn't force a redundant second FFmpeg pass for a source that was
  // already re-packaged into native MP4 here.
  if (session.loudnessNormalization) {
    try {
      const normalizedOpfsName = await normalizeLoudness(session.sourceFilePath, session.sourceFileName);
      session = { ...session, sourceFilePath: normalizedOpfsName, sourceFileName: 'normalized.mp4' };
    } catch (err) {
      post({ type: 'ERROR', error: `Loudness normalization failed: ${err}` });
      return;
    }
  }

  // The actual FFmpeg work (loading the core, decoding, tiling) runs fire-
  // and-forget, not awaited: a scrubbing-preview sprite is a nice-to-have,
  // and the fast (Rust remux) path's whole value proposition is being
  // instant — bolting a mandatory FFmpeg pass in front of *every* job,
  // including that one, would cost it exactly the speed it exists for. Runs
  // concurrently with whichever path handles the main pipeline below
  // instead. Non-fatal on failure, and skipped on RESUME — unlike loudness
  // normalization's own re-derive-from-scratch necessity, this doesn't feed
  // into the main pipeline at all, so re-running it on every resume would
  // just be wasted FFmpeg work for an identical result.
  //
  // Reading the source's own bytes, though, genuinely can't wait: it has to
  // happen *before* the main pipeline gets a chance to finish, or there's a
  // real race against `deleteSession`'s own OPFS cleanup on the React side,
  // which fires the instant that pipeline's own COMPLETE event lands —
  // confirmed happening in well under a second for a fast native-remux job.
  // See generateThumbnailSprite's own doc comment for why merely holding a
  // `File` object across that window isn't actually enough on its own.
  if (cmd.type !== 'RESUME') {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const srcFile = await (await opfsRoot.getFileHandle(session.sourceFilePath)).getFile();
      const srcBytes = new Uint8Array(await srcFile.arrayBuffer());
      generateThumbnailSprite(srcBytes, session.sourceFileName, outputFolderHandle).catch((err: unknown) => {
        log(`Could not generate the scrubbing-preview thumbnail sprite: ${err}`, 'ERROR');
      });
    } catch (err) {
      log(`Could not generate the scrubbing-preview thumbnail sprite: ${err}`, 'ERROR');
    }
  }

  try {
    await writeChaptersVtt(session, outputFolderHandle);
  } catch (err) {
    log(`Could not write chapters.vtt: ${err}`, 'ERROR');
  }

  const subtitleTags = await resolveSubtitleTracks(session, outputFolderHandle);

  // Dub-audio + intro/outro splicing together isn't supported yet: the
  // audio-only renditions built by buildAudioOnlyRenditions only ever cover
  // the main content's own duration, with no equivalent of spliceIntroOutro
  // to extend them across spliced-on intro/outro. Adaptive HLS on its own is
  // supported (see runAbrTranscodingWebCodecs/runAbrTranscoding). Failing
  // clearly here beats silently shipping audio renditions shorter than the
  // spliced video.
  if (session.dubAudioTracks?.length && (session.introOutro?.introFileName || session.introOutro?.outroFileName)) {
    post({ type: 'ERROR', error: 'Dub-audio tracks are not yet supported together with intro/outro.' });
    return;
  }

  // Edited (multi-segment) sources share the same underlying limitation:
  // buildAudioOnlyRenditions/spliceIntroOutro only ever know about the
  // single main-content timeline they were built for, with no equivalent
  // of runSegmentedFastPath's splice for either combination yet.
  const editedSegments = hasEditedSegments(session);
  if (editedSegments && session.dubAudioTracks?.length) {
    post({ type: 'ERROR', error: 'Dub-audio tracks are not yet supported together with edited (trimmed/split) segments.' });
    return;
  }
  if (editedSegments && (session.introOutro?.introFileName || session.introOutro?.outroFileName)) {
    post({ type: 'ERROR', error: 'Intro/outro clips are not yet supported together with edited (trimmed/split) segments.' });
    return;
  }

  // fMP4 output (runFmp4FastPath, runAbrTranscodingWebCodecsFmp4) covers the
  // plain single-quality case and now adaptive HLS/DASH too — everything
  // else (edited segments, dub-audio, subtitles, intro/outro, resume) still
  // only knows how to produce MPEG-TS. Failing clearly here, before any
  // FFmpeg conversion work below, beats silently falling back to MPEG-TS
  // for a container the user explicitly asked for.
  if (session.outputContainer === 'fmp4') {
    const unsupported: string[] = [];
    if (editedSegments) unsupported.push('edited (trimmed/split) segments');
    if (session.dubAudioTracks?.length) unsupported.push('dub-audio tracks');
    if (subtitleTags.length > 0) unsupported.push('subtitles');
    if (session.introOutro?.introFileName || session.introOutro?.outroFileName) unsupported.push('intro/outro');
    if (cmd.type === 'RESUME') unsupported.push('resume');
    if (unsupported.length > 0) {
      post({ type: 'ERROR', error: `Fragmented MP4 output doesn't support ${unsupported.join(', ')} yet — switch back to MPEG-TS or remove them.` });
      return;
    }
  }

  if (session.abrHeights && session.abrHeights.length > 0) {
    if (session.outputContainer === 'fmp4') {
      // No FFmpeg fallback exists for adaptive fMP4/DASH (the FFmpeg ABR
      // path only ever produces MPEG-TS — see runAbrTranscodingWebCodecsFmp4's
      // own doc comment) and edited segments are already rejected above, so
      // this is the one remaining thing to check clearly up front rather
      // than fail deep inside the encode loop.
      const renditions = [...session.abrHeights]
        .sort((a, b) => a - b)
        .map((h) => ABR_LADDER.find((r) => r.height === h))
        .filter((r): r is (typeof ABR_LADDER)[number] => r !== undefined);
      const canUseHardware = await canUseWebCodecsAbr(renditions, session.sourceWidth ?? 0, session.sourceHeight ?? 0);
      if (!canUseHardware) {
        post({ type: 'ERROR', error: 'Adaptive fMP4/DASH output needs hardware video encoding (WebCodecs), which is not available in this browser — switch back to MPEG-TS or use a browser with WebCodecs support.' });
        return;
      }
      await runAbrTranscodingWebCodecsFmp4(session, outputFolderHandle, renditions);
      return;
    }
    if (editedSegments) {
      await runAdaptiveHlsSegmented(session, outputFolderHandle, subtitleTags);
    } else {
      await runAdaptiveHls(session, outputFolderHandle, subtitleTags);
    }
    return;
  }

  // Non-native containers, and native containers whose video codec the
  // chosen output container can't handle (e.g. HEVC + fMP4 output — MPEG-TS
  // output now byte-copies HEVC natively, see needsConversionForUnsupportedCodec
  // above), go through FFmpeg first, producing an MP4 the Rust remuxer can read.
  let effectiveSession = session;
  if (!session.preConverted) {
    const needsConversion =
      !isNativeContainer(session.sourceFileName) ||
      (await needsConversionForUnsupportedCodec(session.sourceFilePath, session.outputContainer ?? 'ts'));
    if (needsConversion) {
      try {
        const convertedOpfsName = await convertToMp4(session.sourceFilePath, session.sourceFileName);
        effectiveSession = { ...session, sourceFilePath: convertedOpfsName, preConverted: true };
        log('File converted. Starting HLS segmentation…');
      } catch (err) {
        post({ type: 'ERROR', error: `FFmpeg conversion failed: ${err}` });
        return;
      }
    }
  }

  if (editedSegments) {
    await runSegmentedFastPath(effectiveSession, outputFolderHandle, subtitleTags);
    return;
  }

  log('Opening source file…');
  let opfsRoot: FileSystemDirectoryHandle;
  try {
    opfsRoot = await navigator.storage.getDirectory();
  } catch (err) {
    post({ type: 'ERROR', error: `OPFS unavailable: ${err}` });
    return;
  }

  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await opfsRoot.getFileHandle(effectiveSession.sourceFilePath);
  } catch (err) {
    post({ type: 'ERROR', error: `Cannot open source file: ${err}` });
    return;
  }

  let syncHandle: FileSystemSyncAccessHandle;
  try {
    syncHandle = await fileHandle.createSyncAccessHandle();
  } catch (err) {
    post({ type: 'ERROR', error: `createSyncAccessHandle failed: ${err}` });
    return;
  }

  try {
    if (session.outputContainer === 'fmp4') {
      await runFmp4FastPath(syncHandle, effectiveSession, outputFolderHandle);
    } else {
      await runWithHandle(syncHandle, effectiveSession, outputFolderHandle, cmd.type === 'RESUME', subtitleTags);
    }
  } finally {
    syncHandle.close();
  }
}

async function runWithHandle(
  syncHandle: FileSystemSyncAccessHandle,
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  isResume: boolean,
  subtitleTags: SubtitleTag[],
): Promise<void> {
  const fileSize = syncHandle.getSize();
  log(`File size: ${(fileSize / 1024 / 1024).toFixed(1)} MiB`);
  log('Reading video headers…');

  // Read up to 32 MiB from the front to find `moov`; if it's not there, the
  // box is usually at the very end (files written without +faststart), so
  // retry against the tail.
  const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
  const headerBuf = readAt(syncHandle, 0, HEADER_READ);

  const { HlsProcessor } = await loadWasm();
  const processor = new HlsProcessor();
  processor.set_target_duration(6.0);

  let parseResult: ParseHeadersResult;
  try {
    const jsonStr = processor.parse_headers(headerBuf) as unknown as string;
    parseResult = JSON.parse(jsonStr) as ParseHeadersResult;
  } catch {
    try {
      const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
      const tailBuf = readAt(syncHandle, tailOffset, fileSize - tailOffset);
      const jsonStr = processor.parse_headers(tailBuf) as unknown as string;
      parseResult = JSON.parse(jsonStr) as ParseHeadersResult;
    } catch (err2) {
      post({ type: 'ERROR', error: `Could not read video headers: ${err2}` });
      return;
    }
  }

  const { segmentCount, segments } = parseResult;
  log(`Found ${segmentCount} segments.`);
  post({ type: 'INITIALIZED', totalSegments: segmentCount });

  // Real-world HLS multi-audio doesn't mux alternate tracks into the video
  // segments — it uses separate audio-only segments per track, switched via
  // an #EXT-X-MEDIA:TYPE=AUDIO group (see buildAudioMediaTag). Once any dub
  // track exists, the main content's own video segments go audio-less too,
  // and its original audio becomes just another rendition in that same
  // group — no special casing, no lost audio, one consistent model. Both
  // come from this same `processor`/`segments`, so their cuts are
  // automatically identical — no alignment work needed for this pair
  // specifically (unlike a genuinely separate dub file, see
  // `remuxDubAudioTrack`).
  const hasDubAudio = !!session.dubAudioTracks?.length;
  const EMPTY = new Uint8Array(0);

  const startIndex = isResume ? Math.max(0, session.lastSegmentIndex + 1) : 0;
  // Recovers pre-pause segment durations from the media playlist already on
  // disk, not from React-side session state — the worker is the only thing
  // that ever actually knows a segment's own duration (see the loop below),
  // and it's the source of truth for a resumed job the same way it already
  // is for a fresh one.
  const durations = isResume ? durationsFromPlaylist((await readOutputFileText(outputFolderHandle, 'index.m3u8')) ?? '') : [];
  let retryCount = 0;
  let totalBytes = 0;

  for (let i = startIndex; i < segmentCount; i++) {
    while (paused && !cancelled) {
      await sleep(200);
    }
    if (cancelled) {
      log('Cancelled.');
      return;
    }

    const seg = segments[i];
    log(`Segment ${i + 1}/${segmentCount}…`);

    let videoData: Uint8Array;
    let audioData: Uint8Array;
    try {
      videoData = readSamples(syncHandle, seg.videoSamples);
      audioData = readSamples(syncHandle, seg.audioSamples);
    } catch (err) {
      if (retryCount < 3) {
        retryCount++;
        log(`Read error on segment ${i}, retrying (${retryCount}/3)…`, 'ERROR');
        i--;
        await sleep(500);
        continue;
      }
      post({ type: 'ERROR', error: `Failed to read segment ${i}: ${err}`, sessionId: session.id });
      return;
    }
    retryCount = 0;

    let tsBytes: Uint8Array;
    try {
      // Passing an empty Uint8Array (rather than omitting real bytes) is
      // what tells the Rust muxer this track isn't present — see
      // mux_segment_inner's has_video/has_audio checks in wasm/src/lib.rs.
      tsBytes = processor.mux_segment(videoData, hasDubAudio ? EMPTY : audioData, i) as Uint8Array;
    } catch (err) {
      if (retryCount < 3) {
        retryCount++;
        log(`Mux error on segment ${i}, retrying…`, 'ERROR');
        i--;
        await sleep(300);
        continue;
      }
      post({ type: 'ERROR', error: `Mux failed for segment ${i}: ${err}`, sessionId: session.id });
      return;
    }

    const segName = `segment_${String(i).padStart(4, '0')}.ts`;
    try {
      await writeOutputFile(outputFolderHandle, segName, tsBytes);
    } catch (err) {
      post({ type: 'ERROR', error: `Failed to write ${segName}: ${err}`, sessionId: session.id });
      return;
    }

    if (hasDubAudio) {
      // The "original" audio, split out as its own audio-only rendition in
      // the same #EXT-X-MEDIA group dub tracks join — same segment index,
      // same processor, so its cuts land exactly where the video's do.
      try {
        const origAudioBytes = processor.mux_segment(EMPTY, audioData, i) as Uint8Array;
        await writeOutputFile(outputFolderHandle, `${ORIGINAL_AUDIO_SEGMENT_PREFIX}${String(i).padStart(4, '0')}.ts`, origAudioBytes);
      } catch (err) {
        post({ type: 'ERROR', error: `Failed to write original-audio segment ${i}: ${err}`, sessionId: session.id });
        return;
      }
    }

    log(`Segment ${i + 1} saved (${(tsBytes.byteLength / 1024).toFixed(0)} KiB)`);
    durations[i] = seg.durationSec;
    totalBytes += tsBytes.byteLength;

    const intermediateDurations = durations.slice(0, i + 1).filter((d) => d !== undefined);
    const m3u8 = buildIntermediateM3U8(intermediateDurations, i === segmentCount - 1);

    try {
      await writeOutputFile(outputFolderHandle, 'index.m3u8', m3u8);
    } catch {
      // Non-fatal — the next segment will retry the write.
    }

    post({
      type: 'SEGMENT_DONE',
      segmentIndex: i,
      totalSegments: segmentCount,
      log: `Segment ${i + 1}/${segmentCount} done`,
      m3u8,
      sessionId: session.id,
    });
  }

  const finalDurations = durations.filter((d) => d !== undefined);
  let outputM3u8 = processor.generate_m3u8(JSON.stringify(finalDurations));
  await writeOutputFile(outputFolderHandle, 'index.m3u8', outputM3u8);

  // Intro/outro splicing: each clip is remuxed (or, if it doesn't match the
  // main content's dimensions, letterboxed to match) through its own
  // HlsProcessor instance, then stitched into a single index.m3u8 — see
  // spliceIntroOutro's comment for why the same-dimensions case needs no
  // muxer changes at all.
  if (session.introOutro?.introFileName || session.introOutro?.outroFileName) {
    outputM3u8 = await spliceIntroOutro(session, outputFolderHandle, outputM3u8);
    await writeOutputFile(outputFolderHandle, 'index.m3u8', outputM3u8);
  }

  // Dub-audio: the "original" audio-only rendition split out of the main
  // content's own segments above shares this same `finalDurations` array —
  // same segments, same durations, just a different filename pattern —
  // plus one more audio-only rendition per dub file, cut at the exact same
  // wall-clock boundaries (see remuxDubAudioTrack). Mutually exclusive with
  // intro/outro (checked in runTranscoding), so `outputM3u8`'s duration
  // here is always just the main content's own — no splicing to account for.
  let audioTags: AudioTrackTag[] | undefined;
  if (hasDubAudio) {
    await writeOutputFile(
      outputFolderHandle,
      ORIGINAL_AUDIO_PLAYLIST,
      buildIntermediateM3U8(finalDurations, true, (i) => `${ORIGINAL_AUDIO_SEGMENT_PREFIX}${String(i).padStart(4, '0')}.ts`),
    );
    audioTags = [{ name: 'Original', language: 'und', playlist: ORIGINAL_AUDIO_PLAYLIST, isDefault: true }];

    const boundaries = segments.map((s) => s.startPtsSec + s.durationSec);
    for (const track of session.dubAudioTracks ?? []) {
      log(`Adding dub audio: ${track.label}…`);
      const segmentPrefix = `dub_${track.language}_`;
      const playlist = `dub_${track.language}.m3u8`;
      const { playlistText, segmentCount: dubSegmentCount } = await remuxDubAudioTrack(track.fileName, segmentPrefix, boundaries, outputFolderHandle);
      // The UI already rejects a dub shorter than the main content before a
      // conversion can even start (see selectDubAudioTrack) — this is a
      // second line of defense for a resumed/stale session that slipped
      // past that check. A rendition with fewer segments than its video
      // counterpart is exactly what produced the real VIDEO_ERROR this
      // guards against: better to fail the job clearly than ship a
      // manifest that looks fine and breaks partway through playback.
      if (dubSegmentCount < boundaries.length) {
        post({
          type: 'ERROR',
          error: `Dub audio "${track.label}" is shorter than the main content and would produce broken playback — use a dub at least as long.`,
          sessionId: session.id,
        });
        return;
      }
      await writeOutputFile(outputFolderHandle, playlist, playlistText);
      audioTags.push({ name: track.label, language: track.language, playlist, isDefault: false });
    }
  }

  // The fast path has no ladder of renditions, so — unlike the ABR paths —
  // it normally never needs a master playlist. #EXT-X-MEDIA only has
  // meaning inside one, though, so a subtitle or dub-audio track forces a
  // minimal, single-variant master.m3u8 into existence here.
  let masterM3u8: string | undefined;
  if (subtitleTags.length > 0 || audioTags) {
    // Derived from the *final* playlist (post intro/outro splicing, if any)
    // rather than summing `finalDurations` directly, so both the subtitle
    // wrapper and the bandwidth estimate below account for spliced-on
    // intro/outro duration too, not just the main content's.
    const totalDuration = totalDurationFromPlaylist(outputM3u8);
    for (const tag of subtitleTags) {
      await writeOutputFile(outputFolderHandle, tag.playlist, buildSubtitlePlaylist(totalDuration, subtitleVttFilename(tag.language)));
    }

    const bandwidth = totalDuration > 0 ? Math.round((totalBytes * 8) / totalDuration) : 1_000_000;
    masterM3u8 = buildFastPathMasterM3U8(bandwidth, session.sourceWidth, session.sourceHeight, subtitleTags, audioTags);
    await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);
  }

  post({
    type: 'COMPLETE',
    totalSegments: segmentCount,
    log: masterM3u8 ? 'Done! master.m3u8 is ready.' : 'Done! index.m3u8 is ready.',
    m3u8: outputM3u8,
    masterM3u8,
    sessionId: session.id,
  });
}

// ── fMP4 fast path ───────────────────────────────────────────────────
//
// The HLS-on-CMAF counterpart of `runWithHandle` above: same per-segment
// read loop, but each segment becomes one video `.m4s` + one audio `.m4s`
// fragment (via HlsProcessor::mux_video_fragment/mux_audio_fragment, see
// wasm/src/fmp4.rs) referencing a shared init segment per track, instead of
// one `.ts` segment holding both. Deliberately scoped to the plain
// single-quality case only — no resume, no dub-audio, no subtitles, no
// intro/outro — see the `outputContainer === 'fmp4'` guards in
// `runTranscoding` that keep this the only path able to reach here.
async function runFmp4FastPath(
  syncHandle: FileSystemSyncAccessHandle,
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
): Promise<void> {
  const fileSize = syncHandle.getSize();
  log(`File size: ${(fileSize / 1024 / 1024).toFixed(1)} MiB`);
  log('Reading video headers…');

  const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
  const headerBuf = readAt(syncHandle, 0, HEADER_READ);

  const { HlsProcessor } = await loadWasm();
  const processor = new HlsProcessor();
  processor.set_target_duration(6.0);

  let parseResult: ParseHeadersResult;
  try {
    parseResult = JSON.parse(processor.parse_headers(headerBuf) as unknown as string) as ParseHeadersResult;
  } catch {
    try {
      const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
      const tailBuf = readAt(syncHandle, tailOffset, fileSize - tailOffset);
      parseResult = JSON.parse(processor.parse_headers(tailBuf) as unknown as string) as ParseHeadersResult;
    } catch (err2) {
      post({ type: 'ERROR', error: `Could not read video headers: ${err2}` });
      return;
    }
  }

  const { segmentCount, segments } = parseResult;
  log(`Found ${segmentCount} segments.`);
  post({ type: 'INITIALIZED', totalSegments: segmentCount });

  const width = session.sourceWidth ?? 0;
  const height = session.sourceHeight ?? 0;

  let initVideo: Uint8Array;
  let initAudio: Uint8Array;
  try {
    initVideo = processor.init_segment_video(width, height) as Uint8Array;
    initAudio = processor.init_segment_audio() as Uint8Array;
  } catch (err) {
    post({ type: 'ERROR', error: `Failed to build init segments: ${err}`, sessionId: session.id });
    return;
  }
  await writeOutputFile(outputFolderHandle, 'init_video.mp4', initVideo);
  await writeOutputFile(outputFolderHandle, 'init_audio.mp4', initAudio);

  const videoFragmentName = (i: number) => `frag_video_${String(i).padStart(4, '0')}.m4s`;
  const audioFragmentName = (i: number) => `frag_audio_${String(i).padStart(4, '0')}.m4s`;

  const durations: number[] = [];
  let totalVideoBytes = 0;
  let totalAudioBytes = 0;
  let retryCount = 0;

  for (let i = 0; i < segmentCount; i++) {
    while (paused && !cancelled) {
      await sleep(200);
    }
    if (cancelled) {
      log('Cancelled.');
      return;
    }

    const seg = segments[i];
    log(`Segment ${i + 1}/${segmentCount}…`);

    let videoData: Uint8Array;
    let audioData: Uint8Array;
    try {
      videoData = readSamples(syncHandle, seg.videoSamples);
      audioData = readSamples(syncHandle, seg.audioSamples);
    } catch (err) {
      if (retryCount < 3) {
        retryCount++;
        log(`Read error on segment ${i}, retrying (${retryCount}/3)…`, 'ERROR');
        i--;
        await sleep(500);
        continue;
      }
      post({ type: 'ERROR', error: `Failed to read segment ${i}: ${err}`, sessionId: session.id });
      return;
    }
    retryCount = 0;

    let fragVideo: Uint8Array;
    let fragAudio: Uint8Array;
    try {
      fragVideo = processor.mux_video_fragment(videoData, i) as Uint8Array;
      fragAudio = processor.mux_audio_fragment(audioData, i) as Uint8Array;
    } catch (err) {
      post({ type: 'ERROR', error: `Fragment mux failed for segment ${i}: ${err}`, sessionId: session.id });
      return;
    }

    try {
      await writeOutputFile(outputFolderHandle, videoFragmentName(i), fragVideo);
      await writeOutputFile(outputFolderHandle, audioFragmentName(i), fragAudio);
    } catch (err) {
      post({ type: 'ERROR', error: `Failed to write segment ${i}: ${err}`, sessionId: session.id });
      return;
    }

    durations[i] = seg.durationSec;
    totalVideoBytes += fragVideo.byteLength;
    totalAudioBytes += fragAudio.byteLength;
    log(`Segment ${i + 1} saved (${((fragVideo.byteLength + fragAudio.byteLength) / 1024).toFixed(0)} KiB)`);

    post({
      type: 'SEGMENT_DONE',
      segmentIndex: i,
      totalSegments: segmentCount,
      log: `Segment ${i + 1}/${segmentCount} done`,
      sessionId: session.id,
    });
  }

  const videoPlaylist = buildFmp4MediaPlaylist(durations, 'init_video.mp4', videoFragmentName);
  const audioPlaylist = buildFmp4MediaPlaylist(durations, 'init_audio.mp4', audioFragmentName);
  await writeOutputFile(outputFolderHandle, 'video.m3u8', videoPlaylist);
  await writeOutputFile(outputFolderHandle, 'audio.m3u8', audioPlaylist);

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const videoBandwidth = totalDuration > 0 ? Math.round((totalVideoBytes * 8) / totalDuration) : 1_000_000;
  const audioBandwidth = totalDuration > 0 ? Math.round((totalAudioBytes * 8) / totalDuration) : 128_000;

  const masterM3u8 = buildFmp4MasterM3U8(videoBandwidth, session.sourceWidth, session.sourceHeight, 'video.m3u8', 'audio.m3u8');
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  // A DASH manifest for the exact same init segments + fragments the HLS
  // playlists above already reference — one more manifest describing
  // files that already exist, not a second encode (see dash.ts).
  try {
    const codecConfig = JSON.parse(processor.codec_config() as unknown as string) as CodecConfig;
    const dashManifest = buildDashManifest(totalDuration, [
      {
        id: 'video',
        mimeType: 'video/mp4',
        codecs: codecConfig.videoCodec,
        bandwidth: videoBandwidth,
        width,
        height,
        initFilename: 'init_video.mp4',
        segmentDurationsSec: durations,
        mediaTemplate: 'frag_video_$Number%04d$.m4s',
      },
      {
        id: 'audio',
        mimeType: 'audio/mp4',
        codecs: codecConfig.audioCodec,
        bandwidth: audioBandwidth,
        audioSamplingRate: codecConfig.audioSampleRate,
        initFilename: 'init_audio.mp4',
        segmentDurationsSec: durations,
        mediaTemplate: 'frag_audio_$Number%04d$.m4s',
      },
    ]);
    await writeOutputFile(outputFolderHandle, 'manifest.mpd', dashManifest);
  } catch (err) {
    // Non-fatal — the HLS output above is already complete and playable;
    // losing the DASH manifest alongside it shouldn't fail the whole job.
    log(`Could not build the DASH manifest: ${err}`, 'ERROR');
  }

  post({
    type: 'COMPLETE',
    totalSegments: segmentCount,
    log: 'Done! master.m3u8 is ready.',
    m3u8: videoPlaylist,
    masterM3u8,
    sessionId: session.id,
  });
}

// ── Intro/outro splicing (fast path) ────────────────────────────────
//
// Every Remux-produced MPEG-TS segment uses the same fixed PID layout
// (VID_PID=0x0100, AUD_PID=0x0101 — see mux_segment in wasm/src/lib.rs), so
// segments from two separate fast-path remux runs are already compatible
// for splicing whenever they share the same frame dimensions: no need for
// a more general multi-source muxer, just reuse HlsProcessor once per clip
// and concatenate the resulting playlists with spliceM3U8Texts. When a
// clip's own dimensions *don't* match the main content's, byte-copying it
// as-is would splice differently-sized segments into one variant — so it's
// re-encoded and letterboxed to match instead, via the same single-source
// WebCodecs/FFmpeg pipeline the ABR paths already use, just for one
// ad-hoc rendition sized to match main exactly rather than a ladder rung.

/** Re-encodes one auxiliary clip to match the main content's exact
 * dimensions (letterboxed/pillarboxed, never stretched or cropped),
 * returning its final playlist text. Tries hardware WebCodecs first, falls
 * back to FFmpeg — the same fallback relationship `runAdaptiveHls` uses for
 * whole ABR jobs, just for this one clip. */
async function encodeAuxiliaryClipMatchingMain(
  opfsFileName: string,
  outputFolderHandle: FileSystemDirectoryHandle,
  mainWidth: number,
  mainHeight: number,
  segmentPrefix: string,
): Promise<string> {
  const rendition = matchMainRendition(mainHeight);

  if (await canUseWebCodecsAbr([rendition], mainWidth, mainHeight)) {
    try {
      const results = await runAbrEncodeForSource(opfsFileName, outputFolderHandle, [rendition], mainWidth, mainHeight, segmentPrefix, false);
      if (results.length > 0) return results[0].playlistText;
      log(`${segmentPrefix}: hardware letterboxing produced no output, falling back to FFmpeg…`, 'ERROR');
    } catch (err) {
      log(`${segmentPrefix}: hardware letterboxing failed (${err}), falling back to FFmpeg…`, 'ERROR');
    }
  }

  const { FFmpeg } = await loadFFmpegModule();
  const { coreURL, wasmURL } = await fetchFFmpegCoreBlobs();
  const opfsRoot = await navigator.storage.getDirectory();
  const { data, inputName } = await loadFFmpegInput(opfsRoot, opfsFileName);
  const results = await encodeRenditionsForSource(
    FFmpeg, coreURL, wasmURL, [rendition], data, inputName, outputFolderHandle, mainWidth, mainHeight, segmentPrefix, '',
    { width: mainWidth, height: mainHeight },
  );
  return results[0].playlistText;
}

/** Produces a spliceable playlist for one intro/outro clip: byte-copied
 * as-is when its dimensions already match the main content's (or aren't
 * known — nothing to compare against), re-encoded and letterboxed to match
 * otherwise. */
async function prepareAuxiliaryClip(
  label: 'intro' | 'outro',
  opfsFileName: string,
  segmentPrefix: string,
  outputFolderHandle: FileSystemDirectoryHandle,
  clipWidth: number | undefined,
  clipHeight: number | undefined,
  mainWidth: number | undefined,
  mainHeight: number | undefined,
): Promise<string> {
  const matchesMain = clipWidth && clipHeight && mainWidth && mainHeight && clipWidth === mainWidth && clipHeight === mainHeight;

  if (matchesMain || !clipWidth || !clipHeight || !mainWidth || !mainHeight) {
    return remuxAuxiliaryClip(opfsFileName, segmentPrefix, outputFolderHandle);
  }

  log(`${label} is ${clipWidth}x${clipHeight}, main content is ${mainWidth}x${mainHeight} — letterboxing to match…`);
  const playlistText = await encodeAuxiliaryClipMatchingMain(opfsFileName, outputFolderHandle, mainWidth, mainHeight, segmentPrefix);
  // The single-rendition encode above wrote its own intermediate playlist
  // (e.g. `intro_main.m3u8`) as a byproduct — nothing references it once
  // its segments are folded into the spliced index.m3u8, same as the ABR
  // path's per-rendition cleanup.
  await removeOutputFileQuietly(outputFolderHandle, `${segmentPrefix}main.m3u8`);
  return playlistText;
}

/** Remuxes one auxiliary clip (intro or outro) with its own HlsProcessor
 * instance — a byte-for-byte copy, same as the fast path's main content —
 * writing `${segmentPrefix}NNNN.ts` files, and returns its final playlist
 * text. Only used when the clip's own dimensions already match the main
 * content's (or aren't known); see `prepareAuxiliaryClip`. */
async function remuxAuxiliaryClip(
  opfsFileName: string,
  segmentPrefix: string,
  outputFolderHandle: FileSystemDirectoryHandle,
): Promise<string> {
  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(opfsFileName);
  const syncHandle = await fileHandle.createSyncAccessHandle();

  try {
    const fileSize = syncHandle.getSize();
    const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
    const headerBuf = readAt(syncHandle, 0, HEADER_READ);

    const { HlsProcessor } = await loadWasm();
    const processor = new HlsProcessor();
    processor.set_target_duration(6.0);

    let parseResult: ParseHeadersResult;
    try {
      parseResult = JSON.parse(processor.parse_headers(headerBuf) as unknown as string) as ParseHeadersResult;
    } catch {
      const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
      const tailBuf = readAt(syncHandle, tailOffset, fileSize - tailOffset);
      parseResult = JSON.parse(processor.parse_headers(tailBuf) as unknown as string) as ParseHeadersResult;
    }

    const segmentName = (i: number) => `${segmentPrefix}${String(i).padStart(4, '0')}.ts`;
    const durations: number[] = [];
    for (let i = 0; i < parseResult.segmentCount; i++) {
      const seg = parseResult.segments[i];
      const videoData = readSamples(syncHandle, seg.videoSamples);
      const audioData = readSamples(syncHandle, seg.audioSamples);
      const tsBytes = processor.mux_segment(videoData, audioData, i) as Uint8Array;
      await writeOutputFile(outputFolderHandle, segmentName(i), tsBytes);
      durations.push(seg.durationSec);
    }
    return buildIntermediateM3U8(durations, true, segmentName);
  } finally {
    syncHandle.close();
  }
}

/** Remuxes one dub-audio file (audio, or a video file whose audio track is
 * read) into its own audio-only HLS rendition — the dub-track counterpart
 * of `remuxAuxiliaryClip` above. Cuts at `boundaries` (the main content's
 * own cumulative segment end times) rather than an independently computed
 * target duration: two files of nearly-but-not-quite-identical length,
 * each cut on its own schedule, would drift apart by a few frames every
 * segment — fine on their own, but exactly what breaks a clean switch
 * between audio renditions mid-playback. `parse_audio_only` populates the
 * track; `segment_audio_at_boundaries` immediately re-cuts it at the real
 * boundaries before anything reads segment count or muxes (see both in
 * wasm/src/lib.rs). */
async function remuxDubAudioTrack(
  opfsFileName: string,
  segmentPrefix: string,
  boundaries: number[],
  outputFolderHandle: FileSystemDirectoryHandle,
): Promise<{ playlistText: string; segmentCount: number }> {
  // parse_audio_only reads an MP4-family box structure directly — anything
  // else (.mp3, .wav, ...) needs FFmpeg to normalize it to .m4a first, same
  // relationship convertToMp4 has to the main content's own fast path.
  const isNativeAudioContainer = isNativeContainer(opfsFileName) || opfsFileName.toLowerCase().endsWith('.m4a');
  const resolvedOpfsName = isNativeAudioContainer ? opfsFileName : await convertAudioToM4a(opfsFileName, opfsFileName);

  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(resolvedOpfsName);
  const syncHandle = await fileHandle.createSyncAccessHandle();

  try {
    const fileSize = syncHandle.getSize();
    const HEADER_READ = Math.min(32 * 1024 * 1024, fileSize);
    const headerBuf = readAt(syncHandle, 0, HEADER_READ);

    const { HlsProcessor } = await loadWasm();
    const processor = new HlsProcessor();

    try {
      processor.parse_audio_only(headerBuf);
    } catch {
      const tailOffset = Math.max(0, fileSize - 32 * 1024 * 1024);
      const tailBuf = readAt(syncHandle, tailOffset, fileSize - tailOffset);
      processor.parse_audio_only(tailBuf);
    }

    const jsonStr = processor.segment_audio_at_boundaries(JSON.stringify(boundaries)) as unknown as string;
    const parseResult = JSON.parse(jsonStr) as AudioOnlyParseResult;

    const segmentName = (i: number) => `${segmentPrefix}${String(i).padStart(4, '0')}.ts`;
    const empty = new Uint8Array(0);
    const durations: number[] = [];
    for (let i = 0; i < parseResult.segmentCount; i++) {
      const seg = parseResult.segments[i];
      const audioData = readSamples(syncHandle, seg.audioSamples);
      const tsBytes = processor.mux_segment(empty, audioData, i) as Uint8Array;
      await writeOutputFile(outputFolderHandle, segmentName(i), tsBytes);
      durations.push(seg.durationSec);
    }
    return { playlistText: buildIntermediateM3U8(durations, true, segmentName), segmentCount: parseResult.segmentCount };
  } finally {
    syncHandle.close();
  }
}

async function spliceIntroOutro(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  mainPlaylistText: string,
): Promise<string> {
  const io = session.introOutro;
  const mainWidth = session.sourceWidth;
  const mainHeight = session.sourceHeight;
  const opfsRoot = await navigator.storage.getDirectory();
  const texts: string[] = [];

  if (io?.introFileName) {
    log('Adding intro…');
    const resolvedName = await resolveIntroOutroClip(io.introFileName, io.introIsImage, io.introDuration, mainWidth, mainHeight);
    try {
      // A synthesized image clip is generated at exactly mainWidth x
      // mainHeight, so it always reports as matching main — no separate
      // letterbox encode needed for it downstream.
      const [clipWidth, clipHeight] = io.introIsImage ? [mainWidth, mainHeight] : [io.introWidth, io.introHeight];
      texts.push(await prepareAuxiliaryClip('intro', resolvedName, 'intro_', outputFolderHandle, clipWidth, clipHeight, mainWidth, mainHeight));
    } finally {
      if (resolvedName !== io.introFileName) await removeOutputFileQuietly(opfsRoot, resolvedName);
    }
  }

  texts.push(mainPlaylistText);

  if (io?.outroFileName) {
    log('Adding outro…');
    const resolvedName = await resolveIntroOutroClip(io.outroFileName, io.outroIsImage, io.outroDuration, mainWidth, mainHeight);
    try {
      const [clipWidth, clipHeight] = io.outroIsImage ? [mainWidth, mainHeight] : [io.outroWidth, io.outroHeight];
      texts.push(await prepareAuxiliaryClip('outro', resolvedName, 'outro_', outputFolderHandle, clipWidth, clipHeight, mainWidth, mainHeight));
    } finally {
      if (resolvedName !== io.outroFileName) await removeOutputFileQuietly(opfsRoot, resolvedName);
    }
  }

  return spliceM3U8Texts(texts);
}

// ── Edited (multi-segment) export — vertical timeline editor ────────
//
// The timeline editor's split/trim/delete/reorder edits flatten into
// `session.segments`: an ordered list of `{sourceStart, sourceEnd}` cuts,
// all drawn from the one main source file. This reuses the exact same
// splice mechanism `spliceIntroOutro` uses for up to 3 named clips from up
// to 3 different files — cut each one out (via `cutSegmentClip`, since
// unlike intro/outro these aren't separate files to begin with), remux it
// independently, and splice the results with `spliceM3U8Texts`, which
// already handles an arbitrary-length list. Every segment shares the main
// content's own dimensions by definition, so none of intro/outro's
// letterboxing logic applies here.

/** True when `session.segments` represents a real edit — more than one
 * segment, or a single segment that doesn't already span the whole source.
 * Lets an unedited export (the common case: load a file, export as-is) skip
 * the extra cut+remux pass entirely and fall through to the existing
 * whole-file fast/ABR paths unchanged. */
/**
 * Fast-path export for a source cut into N ordered, trimmed segments. Each
 * segment is stream-copied out via `cutSegmentClip`, remuxed independently
 * through its own `HlsProcessor` (`remuxAuxiliaryClip` — safe here with no
 * letterboxing, since every segment shares the main content's own
 * dimensions), and the results spliced together. Not resumable, like the
 * ABR paths — a restart begins the whole job over rather than checkpointing
 * mid-cut.
 */
async function runSegmentedFastPath(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  subtitleTags: SubtitleTag[],
): Promise<void> {
  const segments = session.segments ?? [];
  const opfsRoot = await navigator.storage.getDirectory();
  const tempFiles: string[] = [];
  const texts: string[] = [];

  post({ type: 'INITIALIZED', totalSegments: segments.length });

  try {
    for (let i = 0; i < segments.length; i++) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      const { sourceStart, sourceEnd } = segments[i];
      log(`Clip ${i + 1}/${segments.length}: cutting ${sourceStart.toFixed(2)}s–${sourceEnd.toFixed(2)}s…`);
      const tempName = `__segcut_${session.id}_${i}.mp4`;
      await cutSegmentClip(opfsRoot, session.sourceFilePath, sourceStart, sourceEnd, tempName);
      tempFiles.push(tempName);

      log(`Clip ${i + 1}/${segments.length}: remuxing…`);
      texts.push(await remuxAuxiliaryClip(tempName, `seg${i}_`, outputFolderHandle));

      post({
        type: 'SEGMENT_DONE',
        segmentIndex: i,
        totalSegments: segments.length,
        log: `Clip ${i + 1}/${segments.length} done`,
        sessionId: session.id,
      });
    }
  } catch (err) {
    post({ type: 'ERROR', error: `Edited export failed: ${err}`, sessionId: session.id });
    return;
  } finally {
    for (const f of tempFiles) await removeOutputFileQuietly(opfsRoot, f);
  }

  if (cancelled) {
    log('Cancelled.');
    return;
  }

  const outputM3u8 = spliceM3U8Texts(texts);
  await writeOutputFile(outputFolderHandle, 'index.m3u8', outputM3u8);

  // Same reasoning as the whole-file fast path's own tail (runWithHandle):
  // #EXT-X-MEDIA only has meaning inside a multivariant playlist, so a
  // subtitle track forces a minimal master.m3u8 into existence here too.
  let masterM3u8: string | undefined;
  if (subtitleTags.length > 0) {
    const totalDuration = totalDurationFromPlaylist(outputM3u8);
    for (const tag of subtitleTags) {
      await writeOutputFile(outputFolderHandle, tag.playlist, buildSubtitlePlaylist(totalDuration, subtitleVttFilename(tag.language)));
    }
    masterM3u8 = buildFastPathMasterM3U8(1_000_000, session.sourceWidth, session.sourceHeight, subtitleTags, undefined);
    await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);
  }

  post({
    type: 'COMPLETE',
    totalSegments: segments.length,
    log: masterM3u8 ? 'Done! master.m3u8 is ready.' : 'Done! index.m3u8 is ready.',
    m3u8: outputM3u8,
    masterM3u8,
    sessionId: session.id,
  });
}

/** ABR counterpart of `finalizeAbrResults`, generalized from a fixed
 * intro/main/outro triple to an ordered list of per-segment,
 * per-rendition results — one entry in `segmentResultsList` per timeline
 * segment, each already encoded across every selected rendition. Splices
 * per rendition the same way, across however many segments there are. */
async function finalizeAbrResultsSegmented(
  outputFolderHandle: FileSystemDirectoryHandle,
  segmentResultsList: AbrSourceResult[][],
  subtitleTags: SubtitleTag[],
  audioTags?: AudioTrackTag[],
): Promise<{ masterM3u8: string; highestM3u8: string }> {
  const reference = segmentResultsList.find((r) => r.length > 0);
  if (!reference) {
    throw new Error('No rendition produced any output.');
  }

  const streamInfos: { rendition: (typeof ABR_LADDER)[number]; playlist: string; width: number }[] = [];
  let highestM3u8 = '';

  for (const { rendition } of reference) {
    const texts: string[] = [];
    let width = 0;
    for (const segResults of segmentResultsList) {
      const match = segResults.find((r) => r.rendition.height === rendition.height);
      if (match) {
        texts.push(match.playlistText);
        width = match.width;
      }
    }
    if (texts.length === 0) continue;

    const spliced = texts.length > 1 ? spliceM3U8Texts(texts) : texts[0];
    const playlistName = `${rendition.label}.m3u8`;
    await writeOutputFile(outputFolderHandle, playlistName, spliced);
    streamInfos.push({ rendition, playlist: playlistName, width });
    highestM3u8 = spliced;

    // Each segment's own standalone playlist (e.g. `seg2_480p.m3u8`) was
    // only ever a byproduct of encoding it with the same per-source
    // machinery as the main content — nothing references it once its
    // segments are folded into the spliced playlist above.
    for (let i = 0; i < segmentResultsList.length; i++) {
      await removeOutputFileQuietly(outputFolderHandle, `seg${i}_${rendition.label}.m3u8`);
    }
  }

  if (subtitleTags.length > 0) {
    const totalDuration = totalDurationFromPlaylist(highestM3u8);
    for (const tag of subtitleTags) {
      await writeOutputFile(outputFolderHandle, tag.playlist, buildSubtitlePlaylist(totalDuration, subtitleVttFilename(tag.language)));
    }
  }

  const masterM3u8 = buildMasterM3U8(streamInfos, subtitleTags, audioTags);
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  return { masterM3u8, highestM3u8 };
}

/** Encodes one pre-cut segment clip across every selected rendition via
 * FFmpeg (software fallback) and maps the result to the shape
 * `finalizeAbrResultsSegmented` expects — the segmented counterpart of the
 * inline FFmpeg calls in `runAbrTranscoding`. */
async function encodeSegmentWithFfmpeg(
  FFmpeg: FFmpegModule['FFmpeg'],
  coreURL: string,
  wasmURL: string,
  opfsRoot: FileSystemDirectoryHandle,
  outputFolderHandle: FileSystemDirectoryHandle,
  clipOpfsName: string,
  renditions: (typeof ABR_LADDER)[number][],
  sourceWidth: number,
  sourceHeight: number,
  segmentPrefix: string,
): Promise<AbrSourceResult[]> {
  const { data, inputName } = await loadFFmpegInput(opfsRoot, clipOpfsName);
  const results = await encodeRenditionsForSource(
    FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, segmentPrefix, '',
  );
  return results.map((r) => ({ rendition: r.rendition, width: r.width, playlistText: r.playlistText }));
}

/**
 * Adaptive-HLS export for an edited (multi-segment) source — the ABR
 * counterpart of `runSegmentedFastPath`. Each segment is cut once via
 * `cutSegmentClip`, then that cut clip is encoded across every selected
 * rendition (hardware WebCodecs first, FFmpeg fallback — same decision
 * `runAdaptiveHls` makes once for the whole job, made once here too and
 * reused for every segment rather than re-probed per clip), producing an
 * `AbrSourceResult[]` per segment that `finalizeAbrResultsSegmented`
 * splices together per rendition. Not resumable.
 */
async function runAdaptiveHlsSegmented(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  subtitleTags: SubtitleTag[],
): Promise<void> {
  const heights = [...(session.abrHeights ?? [])].sort((a, b) => a - b);
  if (heights.length === 0) {
    post({ type: 'ERROR', error: 'No renditions selected for the adaptive playlist.' });
    return;
  }
  const renditions = heights
    .map((h) => ABR_LADDER.find((r) => r.height === h))
    .filter((r): r is (typeof ABR_LADDER)[number] => r !== undefined);

  const segments = session.segments ?? [];
  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
  const canUseHardware = await canUseWebCodecsAbr(renditions, sourceWidth, sourceHeight);
  if (!canUseHardware) log('Hardware-accelerated encoding is not available here — using FFmpeg instead.');

  const opfsRoot = await navigator.storage.getDirectory();
  const { FFmpeg } = await loadFFmpegModule();
  const { coreURL, wasmURL } = await fetchFFmpegCoreBlobs();

  const tempFiles: string[] = [];
  const segmentResultsList: AbrSourceResult[][] = [];

  post({ type: 'INITIALIZED', totalSegments: segments.length });

  try {
    for (let i = 0; i < segments.length; i++) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      const { sourceStart, sourceEnd } = segments[i];
      log(`Clip ${i + 1}/${segments.length}: cutting ${sourceStart.toFixed(2)}s–${sourceEnd.toFixed(2)}s…`);
      const tempName = `__segcut_${session.id}_${i}.mp4`;
      await cutSegmentClip(opfsRoot, session.sourceFilePath, sourceStart, sourceEnd, tempName);
      tempFiles.push(tempName);

      const prefix = `seg${i}_`;
      let results: AbrSourceResult[];
      if (canUseHardware) {
        try {
          results = await runAbrEncodeForSource(tempName, outputFolderHandle, renditions, sourceWidth, sourceHeight, prefix, false);
        } catch (err) {
          if (cancelled) {
            log('Cancelled.');
            return;
          }
          log(`Clip ${i + 1}: hardware encoding failed (${err}), falling back to FFmpeg…`, 'ERROR');
          results = await encodeSegmentWithFfmpeg(FFmpeg, coreURL, wasmURL, opfsRoot, outputFolderHandle, tempName, renditions, sourceWidth, sourceHeight, prefix);
        }
      } else {
        results = await encodeSegmentWithFfmpeg(FFmpeg, coreURL, wasmURL, opfsRoot, outputFolderHandle, tempName, renditions, sourceWidth, sourceHeight, prefix);
      }
      segmentResultsList.push(results);

      post({
        type: 'SEGMENT_DONE',
        segmentIndex: i,
        totalSegments: segments.length,
        log: `Clip ${i + 1}/${segments.length} encoded`,
        sessionId: session.id,
      });
    }
  } catch (err) {
    if (cancelled) {
      log('Cancelled.');
      return;
    }
    post({ type: 'ERROR', error: `Edited adaptive export failed: ${err}`, sessionId: session.id });
    return;
  } finally {
    for (const f of tempFiles) await removeOutputFileQuietly(opfsRoot, f);
  }

  if (cancelled) {
    log('Cancelled.');
    return;
  }

  const { masterM3u8, highestM3u8 } = await finalizeAbrResultsSegmented(outputFolderHandle, segmentResultsList, subtitleTags, undefined);
  post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8, sessionId: session.id });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
