/**
 * remux.worker.ts — runs the whole transcoding job in a dedicated Web Worker.
 *
 * Reads the source file from OPFS with a sync access handle, drives the Wasm
 * remuxer segment by segment, and writes each segment straight to the output
 * folder. Non-MP4/MOV sources are pre-converted to H.264+AAC MP4 with
 * FFmpeg.wasm first.
 */

import type { WorkerCommand, WorkerEvent, ParseHeadersResult, SegmentInfoJs, AbrRendition } from '../types';
import { isNativeContainer, ABR_LADDER } from '../types';
import { parseCues, serializeVtt, shiftCues } from '../lib/vtt';

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
      '-c:a', 'aac',
      '-b:a', `${rendition.audioBitrateKbps}k`,
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
  subtitleTag?: SubtitleTag,
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

  let introResults: RenditionResult[] | null = null;
  if (introName) {
    try {
      const { data, inputName } = await loadFFmpegInput(opfsRoot, introName);
      introResults = await encodeRenditionsForSource(
        FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, 'intro_', '[intro] ', mainDimensions,
      );
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      log(`Could not encode the intro (${err}) — continuing without it.`, 'ERROR');
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
      FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, '', '',
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
    try {
      const { data, inputName } = await loadFFmpegInput(opfsRoot, outroName);
      outroResults = await encodeRenditionsForSource(
        FFmpeg, coreURL, wasmURL, renditions, data, inputName, outputFolderHandle, sourceWidth, sourceHeight, 'outro_', '[outro] ', mainDimensions,
      );
    } catch (err) {
      if (cancelled) {
        log('Cancelled.');
        return;
      }
      log(`Could not encode the outro (${err}) — continuing without it.`, 'ERROR');
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

  const { masterM3u8, highestM3u8 } = await finalizeAbrResults(
    outputFolderHandle,
    toAbrSourceResults(mainResults) ?? [],
    toAbrSourceResults(introResults),
    toAbrSourceResults(outroResults),
    subtitleTag,
  );

  post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
}

/** Standard 16:9 widths, used only when the source's real aspect ratio wasn't probed. */
const FALLBACK_WIDTH_BY_HEIGHT: Record<number, number> = { 240: 426, 360: 640, 480: 854, 720: 1280 };

function computeRenditionWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
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
function computeLetterboxRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}

function buildMasterM3U8(
  streamInfos: { rendition: (typeof ABR_LADDER)[number]; playlist: string; width: number }[],
  subtitleTag?: SubtitleTag,
): string {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  if (subtitleTag) m += buildSubtitleMediaTag(subtitleTag);
  for (const { rendition, playlist, width } of streamInfos) {
    const bandwidth = (rendition.videoBitrateKbps + rendition.audioBitrateKbps) * 1000;
    const subsAttr = subtitleTag ? `,SUBTITLES="${SUBTITLES_GROUP_ID}"` : '';
    m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${rendition.height}${subsAttr}\n`;
    m += `${playlist}\n`;
  }
  return m;
}

// ── Subtitles (optional sidecar WebVTT track) ───────────────────────
//
// HLS subtitles are a sidecar playlist referenced from the master/
// multivariant playlist via #EXT-X-MEDIA, never muxed into the video/audio
// segments themselves — so wiring them in never touches the Rust remuxer or
// its fixed-PID MPEG-TS muxer, only the JS playlist-building layer here.

const SUBTITLES_GROUP_ID = 'subs';
const SUBTITLE_OUTPUT_FILENAME = 'subtitles.vtt';
/** Per RFC 8216 §4.3.4.1, #EXT-X-MEDIA's URI for TYPE=SUBTITLES must point
 * to a *Media Playlist*, not a raw WebVTT file directly — Shaka (and any
 * spec-correct HLS player) fetches that URI expecting `#EXTM3U` as the
 * first line, and errors (HLS_PLAYLIST_HEADER_MISSING) on raw VTT content.
 * This wraps the single whole-file VTT in a one-segment VOD playlist, the
 * standard pattern for "not actually segmented" WebVTT in HLS. */
const SUBTITLE_PLAYLIST_FILENAME = 'subtitles.m3u8';

interface SubtitleTag {
  name: string;
  /** BCP-47 code, e.g. "en", "it". Without this, HLS defaults the track's
   * language to "und" (undetermined) — which is what made Shaka's UI show
   * "Undetermined" in the subtitle menu instead of a real language name;
   * the NAME attribute isn't what stock player UIs surface there. */
  language: string;
}

function buildSubtitleMediaTag({ name, language }: SubtitleTag): string {
  return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLES_GROUP_ID}",NAME="${name}",LANGUAGE="${language}",DEFAULT=YES,AUTOSELECT=YES,URI="${SUBTITLE_PLAYLIST_FILENAME}"\n`;
}

/** Writes the one-segment media playlist that wraps `subtitles.vtt` — see
 * `SUBTITLE_PLAYLIST_FILENAME`'s comment for why this has to exist at all.
 * `totalDurationSec` should be the *video's* total duration (main content
 * plus any spliced intro/outro), not the VTT's own span: a WebVTT file
 * with cues shorter or longer than the video is fine either way — cues
 * keep their own internal timestamps regardless of this wrapper, and any
 * past the video's end simply never get reached. */
function buildSubtitlePlaylist(totalDurationSec: number): string {
  const target = Math.max(1, Math.ceil(totalDurationSec));
  return (
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    `#EXT-X-TARGETDURATION:${target}\n` +
    '#EXT-X-MEDIA-SEQUENCE:0\n' +
    '#EXT-X-PLAYLIST-TYPE:VOD\n' +
    `#EXTINF:${totalDurationSec.toFixed(6)},\n` +
    `${SUBTITLE_OUTPUT_FILENAME}\n` +
    '#EXT-X-ENDLIST\n'
  );
}

/** Sums every #EXTINF value in an already-built playlist — used to get the
 * *actual* total duration (main content plus any spliced intro/outro) for
 * the subtitle playlist wrapper, without threading a separate duration
 * figure through every call site that can produce a final playlist. */
function totalDurationFromPlaylist(playlistText: string): number {
  let total = 0;
  for (const match of playlistText.matchAll(/#EXTINF:([\d.]+)/g)) {
    total += parseFloat(match[1]);
  }
  return total;
}

/**
 * Reads the raw subtitle file the UI saved to OPFS, converts it to WebVTT
 * with FFmpeg.wasm if it's SRT, and writes the result into the output
 * folder. Returns the display label to use in #EXT-X-MEDIA, or undefined if
 * there's no subtitle track or it couldn't be prepared — a subtitle problem
 * degrades to "no subtitles" rather than failing the whole conversion.
 */
async function resolveSubtitleTrack(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
): Promise<SubtitleTag | undefined> {
  const track = session.subtitleTrack;
  if (!track) return undefined;

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
      log(`Subtitle file doesn't look like WebVTT — first ~150 chars as decoded: ${preview}`);

      // Feed FFmpeg the file as SRT regardless of its original extension:
      // the content just failed a WebVTT-shaped check, and SRT is the only
      // other format the file picker accepts — trusting the extension here
      // is exactly the assumption that got us into this branch in the
      // first place (e.g. asking FFmpeg to read genuinely SRT-formatted
      // content as `sub.vtt` makes its WebVTT demuxer choke on SRT's
      // comma-decimal timestamps instead of converting anything).
      log('Normalizing subtitles to WebVTT…');
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

    // Cues are authored relative to the main content, same as the timeline
    // editor shows them — but once an intro is spliced in front of it, the
    // main content itself starts later in the final output, so every cue
    // needs to shift forward by exactly that much or they'd play back
    // during the intro instead of alongside the footage they were written
    // for.
    const introDuration = session.introOutro?.introDuration;
    if (introDuration && introDuration > 0) {
      vttText = serializeVtt(shiftCues(parseCues(vttText), introDuration));
    }

    await writeOutputFile(outputFolderHandle, SUBTITLE_OUTPUT_FILENAME, vttText);
    return { name: track.label, language: track.language };
  } catch (err) {
    log(`Could not prepare subtitles (${err}) — continuing without them.`, 'ERROR');
    return undefined;
  }
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

function concatChunks(chunks: EncodedChunkInfo[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c.data, offset);
    offset += c.data.byteLength;
  }
  return out;
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
    playlistName: `${pipeline.segmentPrefix}${rendition.label}.m3u8`,
    segmentIndex: 0,
    segmentStartUs: 0,
    videoChunks: [],
    pendingAudioChunks: [],
    durations: [],
    writeQueue: Promise.resolve(),
    broken: false,
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

  const videoData = concatChunks(cut.videoChunks);
  const videoMeta = cut.videoChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: c.isKeyframe }));
  const audioData = concatChunks(cut.audioChunks);
  const audioMeta = cut.audioChunks.map((c) => ({ size: c.data.byteLength, timestampUs: c.timestampUs, isKeyframe: false }));

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

/** Keeps only the `#EXTINF`/segment-name pairs from a playlist, dropping its
 * own header (`#EXTM3U`, `#EXT-X-TARGETDURATION`, ...) and footer
 * (`#EXT-X-ENDLIST`) — the piece that's actually source-specific when
 * splicing several playlists (WebCodecs- or FFmpeg-generated, both are
 * plain text either way) into one. */
function extractPlaylistBody(playlistText: string): string {
  return playlistText
    .split('\n')
    .filter((line) => line.startsWith('#EXTINF') || (line.trim() !== '' && !line.startsWith('#')))
    .join('\n');
}

/** Concatenates 1-3 already-complete variant playlists (intro/main/outro,
 * in that order) for the *same* rendition into one, with an
 * #EXT-X-DISCONTINUITY between each — the ABR counterpart of
 * `buildSplicedM3U8`, which does the same thing for the fast path's
 * duration-array-based playlists instead of pre-built playlist text. */
function spliceM3U8Texts(playlistTexts: string[]): string {
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
  subtitleTag: SubtitleTag | undefined,
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

  if (subtitleTag) {
    const totalDuration = totalDurationFromPlaylist(highestM3u8);
    await writeOutputFile(outputFolderHandle, SUBTITLE_PLAYLIST_FILENAME, buildSubtitlePlaylist(totalDuration));
  }

  const masterM3u8 = buildMasterM3U8(streamInfos, subtitleTag);
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  return { masterM3u8, highestM3u8 };
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
  subtitleTag?: SubtitleTag,
): Promise<void> {
  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
  const introName = session.introOutro?.introFileName;
  const outroName = session.introOutro?.outroFileName;

  let introResults: AbrSourceResult[] | null = null;
  if (introName) {
    try {
      introResults = await runAbrEncodeForSource(introName, outputFolderHandle, renditions, sourceWidth, sourceHeight, 'intro_');
    } catch (err) {
      if (cancelled) return;
      log(`Could not encode the intro (${err}) — continuing without it.`, 'ERROR');
    }
  }
  if (cancelled) return;

  const mainResults = await runAbrEncodeForSource(session.sourceFilePath, outputFolderHandle, renditions, sourceWidth, sourceHeight, '');
  if (cancelled) return;

  let outroResults: AbrSourceResult[] | null = null;
  if (outroName) {
    try {
      outroResults = await runAbrEncodeForSource(outroName, outputFolderHandle, renditions, sourceWidth, sourceHeight, 'outro_');
    } catch (err) {
      if (cancelled) return;
      log(`Could not encode the outro (${err}) — continuing without it.`, 'ERROR');
    }
  }
  if (cancelled) return;

  const { masterM3u8, highestM3u8 } = await finalizeAbrResults(outputFolderHandle, mainResults, introResults, outroResults, subtitleTag);
  post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
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
): Promise<AbrSourceResult[]> {
  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(opfsFileName);
  const syncHandle = await fileHandle.createSyncAccessHandle();
  try {
    return await runAbrWebCodecsWithHandle(syncHandle, outputFolderHandle, renditions, sourceWidth, sourceHeight, segmentPrefix);
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
  };

  const sinks = renditions.map((r) =>
    createRenditionSink(r, computeRenditionWidth(sourceWidth, sourceHeight, r.height), pipeline),
  );

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
  subtitleTag?: SubtitleTag,
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
      await runAbrTranscodingWebCodecs(session, outputFolderHandle, renditions, subtitleTag);
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

  await runAbrTranscoding(session, outputFolderHandle, subtitleTag);
}

// ── Helpers ──────────────────────────────────────────────────────

function post(event: WorkerEvent) {
  self.postMessage(event);
}

function log(msg: string, level: WorkerEvent['type'] = 'PROGRESS') {
  post({ type: level, log: msg });
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

async function runTranscoding(cmd: WorkerCommand): Promise<void> {
  const { session } = cmd;
  const outputFolderHandle = cmd.outputFolderHandle ?? session.outputFolderHandle;

  if (!outputFolderHandle) {
    post({ type: 'ERROR', error: 'No output folder selected.' });
    return;
  }

  const subtitleTag = await resolveSubtitleTrack(session, outputFolderHandle);

  if (session.abrHeights && session.abrHeights.length > 0) {
    await runAdaptiveHls(session, outputFolderHandle, subtitleTag);
    return;
  }

  // Non-native containers go through FFmpeg first, producing an MP4 the Rust
  // remuxer can read.
  let effectiveSession = session;
  if (!isNativeContainer(session.sourceFileName) && !session.preConverted) {
    try {
      const convertedOpfsName = await convertToMp4(session.sourceFilePath, session.sourceFileName);
      effectiveSession = { ...session, sourceFilePath: convertedOpfsName, preConverted: true };
      log('File converted. Starting HLS segmentation…');
    } catch (err) {
      post({ type: 'ERROR', error: `FFmpeg conversion failed: ${err}` });
      return;
    }
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
    await runWithHandle(syncHandle, effectiveSession, outputFolderHandle, cmd.type === 'RESUME', subtitleTag);
  } finally {
    syncHandle.close();
  }
}

async function runWithHandle(
  syncHandle: FileSystemSyncAccessHandle,
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  isResume: boolean,
  subtitleTag?: SubtitleTag,
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

  const startIndex = isResume ? Math.max(0, session.lastSegmentIndex + 1) : 0;
  const durations = isResume ? [...session.segmentDurations] : [];
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
      tsBytes = processor.mux_segment(videoData, audioData, i) as Uint8Array;
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

  // The fast path has no ladder of renditions, so — unlike the ABR paths —
  // it normally never needs a master playlist. #EXT-X-MEDIA only has
  // meaning inside one, though, so a subtitle track forces a minimal,
  // single-variant master.m3u8 into existence here.
  let masterM3u8: string | undefined;
  if (subtitleTag) {
    // Derived from the *final* playlist (post intro/outro splicing, if any)
    // rather than summing `finalDurations` directly, so both the subtitle
    // wrapper and the bandwidth estimate below account for spliced-on
    // intro/outro duration too, not just the main content's.
    const totalDuration = totalDurationFromPlaylist(outputM3u8);
    await writeOutputFile(outputFolderHandle, SUBTITLE_PLAYLIST_FILENAME, buildSubtitlePlaylist(totalDuration));

    const bandwidth = totalDuration > 0 ? Math.round((totalBytes * 8) / totalDuration) : 1_000_000;
    masterM3u8 = buildFastPathMasterM3U8(subtitleTag, bandwidth, session.sourceWidth, session.sourceHeight);
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

function buildFastPathMasterM3U8(subtitleTag: SubtitleTag, bandwidth: number, width?: number, height?: number): string {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  m += buildSubtitleMediaTag(subtitleTag);
  const resAttr = width && height ? `,RESOLUTION=${width}x${height}` : '';
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resAttr},SUBTITLES="${SUBTITLES_GROUP_ID}"\n`;
  m += 'index.m3u8\n';
  return m;
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

/** A one-off "rendition" matching the main content's own resolution —
 * reuses the ABR encode pipeline to letterbox/pillarbox an intro/outro
 * clip into that exact size, without it needing to be an actual ladder
 * rung. Bitrate is generous (bumpers are short; quality matters more than
 * file size here) and floored well above the 96kbps WebCodecs AAC floor
 * documented on ABR_LADDER. */
function matchMainRendition(mainHeight: number): AbrRendition {
  return {
    height: mainHeight,
    label: 'main',
    videoBitrateKbps: Math.max(1200, Math.round(mainHeight * 6)),
    audioBitrateKbps: 128,
  };
}

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
      const results = await runAbrEncodeForSource(opfsFileName, outputFolderHandle, [rendition], mainWidth, mainHeight, segmentPrefix);
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

async function spliceIntroOutro(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  mainPlaylistText: string,
): Promise<string> {
  const io = session.introOutro;
  const mainWidth = session.sourceWidth;
  const mainHeight = session.sourceHeight;
  const texts: string[] = [];

  if (io?.introFileName) {
    log('Adding intro…');
    texts.push(
      await prepareAuxiliaryClip('intro', io.introFileName, 'intro_', outputFolderHandle, io.introWidth, io.introHeight, mainWidth, mainHeight),
    );
  }

  texts.push(mainPlaylistText);

  if (io?.outroFileName) {
    log('Adding outro…');
    texts.push(
      await prepareAuxiliaryClip('outro', io.outroFileName, 'outro_', outputFolderHandle, io.outroWidth, io.outroHeight, mainWidth, mainHeight),
    );
  }

  return spliceM3U8Texts(texts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultSegmentName(i: number): string {
  return `segment_${String(i).padStart(4, '0')}.ts`;
}

function buildIntermediateM3U8(durations: number[], isFinal: boolean, segmentName: (i: number) => string = defaultSegmentName): string {
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
