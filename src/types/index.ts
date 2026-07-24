// ── Session (persisted to IndexedDB) ──────────────────────────────

export interface TranscodingSession {
  id: string;
  sourceFileName: string;
  /** OPFS filename — may point to an FFmpeg-converted MP4 if the input wasn't native. */
  sourceFilePath: string;
  sourceFileSize: number;
  preConverted?: boolean;
  /** Index of the last segment successfully written; -1 means none yet. */
  lastSegmentIndex: number;
  totalSegments: number;
  segmentDurations: number[];
  m3u8Content: string;
  outputFolderHandle: FileSystemDirectoryHandle | null;
  createdAt: number;
  updatedAt: number;
  /** Source video dimensions, probed client-side when the file is picked. Used to size ABR renditions. */
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * Rendition heights (e.g. [240, 480]) for an adaptive-bitrate job. When set
   * and non-empty, the worker skips the fast Rust remux path entirely and
   * re-encodes one HLS rendition per height instead (WebCodecs when
   * available, FFmpeg.wasm otherwise). ABR jobs are not resumable — a
   * restart begins the whole job over.
   */
  abrHeights?: number[];
  /**
   * Optional sidecar subtitle track (WebVTT, or SRT converted to WebVTT by
   * the worker). `fileName` is the OPFS filename of the raw uploaded file.
   * When set, the worker always emits a master.m3u8 — even on the fast
   * path, which otherwise has none — since #EXT-X-MEDIA only has meaning
   * inside a multivariant playlist.
   */
  subtitleTrack?: { fileName: string; label: string; language: string };
  /**
   * Optional intro/outro clips (OPFS filenames of native MP4/MOV files),
   * spliced onto the start/end of the output — on the fast path directly,
   * and on ABR jobs once per selected rendition. When a clip's own probed
   * dimensions (`introWidth`/`introHeight`, `outroWidth`/`outroHeight`)
   * don't match the main content's, it's letterboxed/pillarboxed to match
   * rather than spliced in at a different resolution or stretched — see
   * `computeLetterboxRect` in the worker.
   */
  introOutro?: {
    introFileName?: string;
    introWidth?: number;
    introHeight?: number;
    /** Seconds, probed client-side — used to shift subtitle cue timestamps
     * (authored relative to the main content) forward so they still land
     * on the right moment once an intro is spliced in front of it. */
    introDuration?: number;
    outroFileName?: string;
    outroWidth?: number;
    outroHeight?: number;
  };
}

// ── Adaptive bitrate (multi-resolution) ────────────────────────────

export interface AbrRendition {
  /** A literal 240/360/480/720 for the ladder rungs below, but widened to
   * `number` so an intro/outro mismatch fix can also build a one-off
   * rendition matching the main content's own (arbitrary) height. */
  height: number;
  label: string;
  /** Encoder target width when scaling, kept even via ffmpeg's scale=-2:h. */
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

/**
 * A conventional ABR ladder. Bitrates are rough, widely-used defaults for
 * each rung (H.264 + AAC) — good enough for local playback, not tuned per
 * source. BANDWIDTH in the master playlist is derived from these.
 *
 * The audio floor is 96, not the more conventional 64, for stereo sources:
 * Chrome's WebCodecs AAC encoder was found (empirically, bisecting between
 * 64 and 96 against real 48kHz stereo footage) to reliably fail to finish
 * encoding — `AudioEncoder.flush()` rejects with a bare "Encoding error.",
 * no further detail — at 64kbps stereo specifically, regardless of source
 * content, sample rate, or resolution. 96kbps was reliable in every test.
 * Mono sources aren't affected, but the ladder doesn't know a given source's
 * channel count ahead of encoding, so the floor is unconditional.
 */
export const ABR_LADDER: AbrRendition[] = [
  { height: 240, label: '240p', videoBitrateKbps: 400, audioBitrateKbps: 96 },
  { height: 360, label: '360p', videoBitrateKbps: 800, audioBitrateKbps: 96 },
  { height: 480, label: '480p', videoBitrateKbps: 1400, audioBitrateKbps: 128 },
  { height: 720, label: '720p', videoBitrateKbps: 2800, audioBitrateKbps: 128 },
];

// ── Worker messages ────────────────────────────────────────────────

export type WorkerCommandType = 'START' | 'RESUME' | 'PAUSE' | 'CANCEL';

export interface WorkerCommand {
  type: WorkerCommandType;
  session: TranscodingSession;
  outputFolderHandle?: FileSystemDirectoryHandle;
}

export type WorkerEventType =
  | 'INITIALIZED'
  | 'SEGMENT_DONE'
  | 'PROGRESS'
  | 'COMPLETE'
  | 'ERROR'
  | 'PAUSED'
  | 'CONVERTING';

export interface WorkerEvent {
  type: WorkerEventType;
  segmentIndex?: number;
  totalSegments?: number;
  log?: string;
  error?: string;
  m3u8?: string;
  sessionId?: string;
  /** 0-100 during the FFmpeg pre-conversion step, or overall progress across all ABR renditions. */
  convertProgress?: number;
  /** Set during an ABR job — which rendition (e.g. "480p") is currently encoding. */
  renditionLabel?: string;
  /** The master playlist text — only set on the COMPLETE event of an ABR job. */
  masterM3u8?: string;
}

// ── UI state ───────────────────────────────────────────────────────

export type AppStatus =
  | 'idle'
  | 'saving-to-opfs'
  | 'converting'
  | 'processing'
  | 'paused'
  | 'complete'
  | 'error';

export interface LogEntry {
  id: number;
  timestamp: number;
  message: string;
  level: 'info' | 'success' | 'warn' | 'error';
}

// ── Wasm result types (mirror the Rust structs) ────────────────────

export interface SampleInfoJs {
  fileOffset: number;
  size: number;
  pts: number;
  dts: number;
  duration: number;
  isKeyframe: boolean;
}

export interface SegmentInfoJs {
  startPtsSec: number;
  durationSec: number;
  videoSamples: SampleInfoJs[];
  audioSamples: SampleInfoJs[];
}

export interface ParseHeadersResult {
  segmentCount: number;
  videoTimescale: number;
  audioTimescale: number;
  targetDuration: number;
  segments: SegmentInfoJs[];
}

// ── Format detection ─────────────────────────────────────────────

/**
 * mp4/mov/m4v/3gp/f4v go straight through the Rust remuxer.
 * Everything else is pre-converted with FFmpeg.wasm first.
 */
export const SUPPORTED_VIDEO_MIME_TYPES =
  'video/mp4,video/quicktime,video/x-matroska,video/webm,video/avi,video/x-msvideo,video/x-flv,video/x-ms-wmv,video/mpeg,video/ogg,.mp4,.mov,.m4v,.mkv,.webm,.avi,.wmv,.flv,.ts,.mts,.m2ts,.ogv,.mpg,.mpeg,.3gp,.f4v';

export function isNativeContainer(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'mov', 'm4v', '3gp', 'f4v'].includes(ext);
}
