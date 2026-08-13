// ── Session (persisted to IndexedDB) ──────────────────────────────

export interface TranscodingSession {
  id: string;
  sourceFileName: string;
  /** OPFS filename — may point to an FFmpeg-converted MP4 if the input wasn't native. */
  sourceFilePath: string;
  sourceFileSize: number;
  preConverted?: boolean;
  /**
   * Fast-path output container — `'ts'` (default, unset) or `'fmp4'`
   * (HLS-on-CMAF: an `#EXT-X-MAP` init segment per rendition, `.m4s`
   * fragments). Only the plain single-quality fast path supports `'fmp4'`
   * so far — ABR, edited (trimmed/split) segments, dub-audio, subtitles,
   * and intro/outro all still only ever produce MPEG-TS; see the
   * `outputContainer === 'fmp4'` guards in remux.worker.ts's
   * `runTranscoding`.
   */
  outputContainer?: 'ts' | 'fmp4';
  /**
   * When true, the main content's audio is run through an EBU R128 loudness
   * normalization pass (FFmpeg's two-pass `loudnorm` filter, I=-23:TP=-1:LRA=7
   * — the broadcast target, not a streaming-platform one) before anything
   * else touches it. Scoped to the main content only — intro/outro and
   * dub-audio tracks are left as-is, matching how other main-content-only
   * features on this roadmap started (see fMP4's own single-quality-first
   * scope). Video is always stream-copied during this pass, never re-encoded.
   */
  loudnessNormalization?: boolean;
  /** Index of the last segment successfully written; -1 means none yet. */
  lastSegmentIndex: number;
  totalSegments: number;
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
   * Optional sidecar subtitle tracks (WebVTT, or SRT converted to WebVTT by
   * the worker) — any number of them, each its own `#EXT-X-MEDIA:
   * TYPE=SUBTITLES` rendition sharing one GROUP-ID, the same "several
   * tracks, one group" shape `dubAudioTracks` below already uses for audio.
   * `fileName` is the OPFS filename of the raw uploaded file. When
   * non-empty, the worker always emits a master.m3u8 — even on the fast
   * path, which otherwise has none — since #EXT-X-MEDIA only has meaning
   * inside a multivariant playlist.
   */
  subtitleTracks?: { fileName: string; label: string; language: string }[];
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
     * on the right moment once an intro is spliced in front of it. For a
     * still-image intro (`introIsImage`), this is instead the user-chosen
     * hold length, and doubles as the worker's synthesis duration. */
    introDuration?: number;
    /** True when the intro is a still image rather than a video — the
     * worker synthesizes a short held clip from it first (see
     * `convertImageToClip` in remux.worker.ts), scaled/padded to the main
     * content's own dimensions, before splicing it in like any other
     * same-size video intro. */
    introIsImage?: boolean;
    outroFileName?: string;
    outroWidth?: number;
    outroHeight?: number;
    /** Outro's own probed/held length — the asymmetric twin of
     * `introDuration` above (previously never captured at all; see
     * useTranscoder.ts's `start()`), needed to know a still-image outro's
     * hold length the same way `introDuration` does for the intro. */
    outroDuration?: number;
    outroIsImage?: boolean;
  };
  /**
   * Optional dub-audio tracks (OPFS filenames of audio or video files, only
   * their audio is read). Per real-world HLS practice, these aren't muxed
   * into the video segments alongside the original audio — the main
   * content's video segments become video-only, its own audio becomes an
   * audio-only rendition in its own right, and every dub track is another
   * audio-only rendition alongside it, all in the same `#EXT-X-MEDIA:
   * TYPE=AUDIO` group so a player can switch between them. Forces a
   * master.m3u8 on the fast path, same reason as `subtitleTrack`.
   */
  dubAudioTracks?: { fileName: string; language: string; label: string }[];
  /**
   * Ordered, trimmed sub-ranges of the main source file — the vertical
   * timeline editor's split/trim/delete/reorder edits, flattened into a cut
   * list. Each entry is stream-copied out of the main file with FFmpeg and
   * re-spliced with `#EXT-X-DISCONTINUITY` between them (see
   * `cutSegmentClip`/`runSegmentedFastPath`/`runAdaptiveHlsSegmented` in
   * remux.worker.ts) — the same splice mechanism `introOutro` above already
   * uses for up to 3 named clips, generalized to an arbitrary-length list
   * all drawn from the one source. Present (even as a single full-span
   * entry) for every session the current editor creates; a single entry
   * spanning the whole source is treated as "no real edit" and skips the
   * extra cut+remux pass. Mutually exclusive with `introOutro` and
   * `dubAudioTracks` for now — see the worker's guards in `runTranscoding`.
   */
  segments?: { sourceStart: number; sourceEnd: number }[];
  /**
   * Source duration in seconds, probed client-side when the file is picked
   * (same probe that fills `sourceWidth`/`sourceHeight`). Lets the worker
   * tell a trivial single full-span `segments` entry (no real edit) apart
   * from a genuine trim.
   */
  sourceDuration?: number;
  /**
   * Chapter markers for the player's native chapters menu. `time` is
   * already in the flattened/output timeline's own coordinates (see
   * `lib/chapters.ts`), not source-relative like `subtitleTracks`' cues, so
   * the worker needs no `segments`-based remapping step for these — just
   * `buildChaptersVtt` to turn them into `chapters.vtt`.
   */
  chapters?: { time: number; title: string }[];
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
  /**
   * Display styling for `log`, independent of `type` — a `PROGRESS` event
   * carrying a recoverable-fallback message (e.g. "hardware encoding
   * failed, falling back to FFmpeg…") still needs to show red in the log
   * console, but must NOT flip the whole job to `type: 'ERROR'`, which is
   * reserved for genuine, job-ending failures (see remux.worker.ts's own
   * `log` helper). Falls back to the old type-based inference in
   * useTranscoder when unset, for COMPLETE/ERROR/PAUSED events that don't
   * bother setting this explicitly.
   */
  logLevel?: 'info' | 'success' | 'warn' | 'error';
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
  /** 'hevc' or 'avc' — the fast path can byte-copy either into MPEG-TS
   * output, but fMP4 output and WebCodecs ABR both still require 'avc' (see
   * `needsConversionForUnsupportedCodec` and `HlsProcessor::codec_config`
   * in wasm/src/lib.rs). */
  videoCodec: 'avc' | 'hevc';
}

/** Result shape of `HlsProcessor.parse_audio_only`/`segment_audio_at_boundaries`
 * — same idea as `ParseHeadersResult`, but there's no video track at all, so
 * no `videoTimescale`. `videoSamples` is still present on each segment (see
 * `SegmentInfoJs`), just always `[]`. */
export interface AudioOnlyParseResult {
  segmentCount: number;
  audioTimescale: number;
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

/** Extension-based check for a still image, shared between the client (an
 * intro/outro file picker) and the worker (deciding whether to synthesize a
 * held clip from an OPFS filename before splicing — see
 * `convertImageToClip` in remux.worker.ts). Client code additionally checks
 * the `File`'s own MIME type first (see useTranscoder.ts's `isImageFile`);
 * an OPFS filename has no MIME type to fall back to, so the worker relies on
 * this extension check alone, the same way `isNativeContainer` above does. */
export function isImageFileName(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
}
