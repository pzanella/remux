/**
 * remux.worker.ts — runs the whole transcoding job in a dedicated Web Worker.
 *
 * Reads the source file from OPFS with a sync access handle, drives the Wasm
 * remuxer segment by segment, and writes each segment straight to the output
 * folder. Non-MP4/MOV sources are pre-converted to H.264+AAC MP4 with
 * FFmpeg.wasm first.
 */

import type { WorkerCommand, WorkerEvent, ParseHeadersResult, SegmentInfoJs } from '../types';
import { isNativeContainer, ABR_LADDER } from '../types';

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
type WasmModule = typeof import('../wasm/remux_core.js');
let _wasmModule: WasmModule | null = null;
async function loadWasm(): Promise<WasmModule> {
  if (!_wasmModule) {
    _wasmModule = await import('../wasm/remux_core.js');
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
): Promise<RenditionResult> {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => onProgress(Math.min(Math.max(progress, 0), 1)));

  await ffmpeg.load({ coreURL, wasmURL }, { signal });
  await ffmpeg.writeFile(inputName, inputData.slice(), { signal });

  const playlistName = `${rendition.label}.m3u8`;
  const segmentPattern = `${rendition.label}_%04d.ts`;

  await ffmpeg.exec(
    [
      '-i', inputName,
      '-vf', `scale=-2:${rendition.height}`,
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

  const width = computeRenditionWidth(sourceWidth, sourceHeight, rendition.height);
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
async function runAbrTranscoding(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
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
  const renditionLabels = renditions.map((r) => r.label).join(', ');

  log('Loading source file…');
  const { FFmpeg } = await loadFFmpegModule();
  const { fetchFile } = await import('@ffmpeg/util');
  const { coreURL, wasmURL } = await fetchFFmpegCoreBlobs();

  const opfsRoot = await navigator.storage.getDirectory();
  const srcHandle = await opfsRoot.getFileHandle(session.sourceFilePath);
  const srcFile: File = await srcHandle.getFile();
  const inputData = (await fetchFile(srcFile)) as Uint8Array;

  const ext = session.sourceFileName.includes('.')
    ? session.sourceFileName.slice(session.sourceFileName.lastIndexOf('.'))
    : '.video';
  const inputName = `input${ext}`;

  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;

  log(`Encoding ${renditions.length} rendition${renditions.length > 1 ? 's' : ''} in parallel: ${renditionLabels}…`);

  abrAbortController = new AbortController();
  const { signal } = abrAbortController;

  const progressByIndex = new Array<number>(renditions.length).fill(0);
  const progressTimer = setInterval(() => {
    const avg = progressByIndex.reduce((a, b) => a + b, 0) / renditions.length;
    post({
      type: 'CONVERTING',
      log: `Encoding ${renditionLabels}… ${Math.round(avg * 100)}%`,
      convertProgress: Math.min(Math.round(avg * 100), 99),
      renditionLabel: renditionLabels,
    });
  }, 500);

  let results: RenditionResult[];
  try {
    results = await Promise.all(
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
        ),
      ),
    );
  } catch (err) {
    clearInterval(progressTimer);
    abrAbortController = null;
    if (cancelled) {
      log('Cancelled.');
      return;
    }
    post({ type: 'ERROR', error: `Encoding failed: ${err}` });
    return;
  }
  clearInterval(progressTimer);
  abrAbortController = null;

  for (const r of results) {
    post({
      type: 'SEGMENT_DONE',
      log: `${r.rendition.label} done (${r.segmentCount} segments)`,
      m3u8: r.playlistText,
      convertProgress: 100,
    });
  }

  const masterM3u8 = buildMasterM3U8(results.map((r) => ({ rendition: r.rendition, playlist: r.playlist, width: r.width })));
  await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

  const highest = results[results.length - 1];
  post({
    type: 'COMPLETE',
    log: 'Done! master.m3u8 is ready.',
    m3u8: highest?.playlistText || masterM3u8,
    masterM3u8,
  });
}

/** Standard 16:9 widths, used only when the source's real aspect ratio wasn't probed. */
const FALLBACK_WIDTH_BY_HEIGHT: Record<number, number> = { 240: 426, 360: 640, 480: 854, 720: 1280 };

function computeRenditionWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
  if (sourceWidth > 0 && sourceHeight > 0) {
    return Math.round((sourceWidth / sourceHeight) * (targetHeight / 2)) * 2;
  }
  return FALLBACK_WIDTH_BY_HEIGHT[targetHeight] ?? targetHeight;
}

function buildMasterM3U8(
  streamInfos: { rendition: (typeof ABR_LADDER)[number]; playlist: string; width: number }[],
): string {
  let m = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const { rendition, playlist, width } of streamInfos) {
    const bandwidth = (rendition.videoBitrateKbps + rendition.audioBitrateKbps) * 1000;
    m += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${rendition.height}\n`;
    m += `${playlist}\n`;
  }
  return m;
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
    playlistName: `${rendition.label}.m3u8`,
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

  const segName = `${sink.rendition.label}_${String(sink.segmentIndex).padStart(4, '0')}.ts`;
  await writeOutputFile(sink.pipeline.outputFolderHandle, segName, tsBytes);

  sink.durations.push((cut.endUs - cut.startUs) / 1_000_000);
  sink.segmentIndex++;

  const segmentName = (i: number) => `${sink.rendition.label}_${String(i).padStart(4, '0')}.ts`;
  const m3u8 = buildIntermediateM3U8(sink.durations, isFinal, segmentName);
  await writeOutputFile(sink.pipeline.outputFolderHandle, sink.playlistName, m3u8);
}

async function runAbrTranscodingWebCodecs(
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
): Promise<void> {
  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(session.sourceFilePath);
  const syncHandle = await fileHandle.createSyncAccessHandle();
  try {
    await runAbrWebCodecsWithHandle(syncHandle, session, outputFolderHandle, renditions);
  } finally {
    syncHandle.close();
  }
}

async function runAbrWebCodecsWithHandle(
  syncHandle: FileSystemSyncAccessHandle,
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  renditions: (typeof ABR_LADDER)[number][],
): Promise<void> {
  const renditionLabels = renditions.map((r) => r.label).join(', ');
  log(`Encoding ${renditions.length} rendition${renditions.length > 1 ? 's' : ''} with hardware acceleration: ${renditionLabels}…`);

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
  };

  const sourceWidth = session.sourceWidth ?? 0;
  const sourceHeight = session.sourceHeight ?? 0;
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
      sink.ctx.drawImage(frame, 0, 0, sink.width, sink.rendition.height);
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
          post({ type: 'CONVERTING', log: `Decoding and encoding… ${pct}%`, convertProgress: pct, renditionLabel: renditionLabels });
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
      return;
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
        return;
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

    post({ type: 'CONVERTING', log: 'Finalizing renditions…', convertProgress: 90, renditionLabel: renditionLabels });

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
    // left out of the master playlist rather than referencing a file that
    // doesn't exist.
    const producedSinks = sinks.filter((s) => s.durations.length > 0);
    if (producedSinks.length === 0) {
      throw new Error('No rendition produced any output.');
    }

    const masterM3u8 = buildMasterM3U8(
      producedSinks.map((s) => ({ rendition: s.rendition, playlist: s.playlistName, width: s.width })),
    );
    await writeOutputFile(outputFolderHandle, 'master.m3u8', masterM3u8);

    const highest = producedSinks[producedSinks.length - 1];
    const highestM3u8 = buildIntermediateM3U8(
      highest.durations,
      true,
      (i) => `${highest.rendition.label}_${String(i).padStart(4, '0')}.ts`,
    );

    post({ type: 'COMPLETE', log: 'Done! master.m3u8 is ready.', m3u8: highestM3u8, masterM3u8 });
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
      await runAbrTranscodingWebCodecs(session, outputFolderHandle, renditions);
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

  await runAbrTranscoding(session, outputFolderHandle);
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

  if (session.abrHeights && session.abrHeights.length > 0) {
    await runAdaptiveHls(session, outputFolderHandle);
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
    await runWithHandle(syncHandle, effectiveSession, outputFolderHandle, cmd.type === 'RESUME');
  } finally {
    syncHandle.close();
  }
}

async function runWithHandle(
  syncHandle: FileSystemSyncAccessHandle,
  session: import('../types').TranscodingSession,
  outputFolderHandle: FileSystemDirectoryHandle,
  isResume: boolean,
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
  const finalM3u8 = processor.generate_m3u8(JSON.stringify(finalDurations));
  await writeOutputFile(outputFolderHandle, 'index.m3u8', finalM3u8);

  post({
    type: 'COMPLETE',
    totalSegments: segmentCount,
    log: 'Done! index.m3u8 is ready.',
    m3u8: finalM3u8,
    sessionId: session.id,
  });
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
