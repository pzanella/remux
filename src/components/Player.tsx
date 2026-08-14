/**
 * In-browser HLS playback with Shaka Player, reading segments straight from a
 * FileSystemDirectoryHandle — no server needed. A custom `localdir` scheme
 * plugin serves the manifest (kept in memory, never written to disk) and
 * every relative reference Shaka resolves against it — segments, per-
 * rendition playlists, subtitle tracks — by filename against the local
 * output folder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import shaka from 'shaka-player/dist/shaka-player.ui';
import 'shaka-player/dist/controls.css';
import { retryUntilCancelled } from '../lib/retry';

const SCHEME = 'localdir';
const MANIFEST_URI = `${SCHEME}://root/__manifest__.m3u8`;
const URI_PREFIX = `${SCHEME}://root/`;

let polyfillsInstalled = false;
function ensurePolyfills() {
  if (!polyfillsInstalled) {
    shaka.polyfill.installAll();
    polyfillsInstalled = true;
  }
}

function registerLocalDirScheme(dirHandle: FileSystemDirectoryHandle, readManifest: () => string) {
  const plugin: shaka.extern.SchemePlugin = (uri, request) => {
    const promise = (async (): Promise<shaka.extern.Response> => {
      const path = uri.slice(URI_PREFIX.length).split('?')[0];
      let data: ArrayBuffer;

      if (path === '__manifest__.m3u8') {
        data = new TextEncoder().encode(readManifest()).buffer;
      } else {
        const fileHandle = await dirHandle.getFileHandle(path);
        const file = await fileHandle.getFile();
        data = await file.arrayBuffer();
      }

      return { uri, originalUri: uri, data, headers: {}, status: 200, originalRequest: request };
    })();

    return shaka.util.AbortableOperation.notAbortable(promise);
  };

  shaka.net.NetworkingEngine.registerScheme(SCHEME, plugin);
}

/**
 * Loads the scrubbing-preview thumbnail sprite (see generateThumbnailSprite
 * in remux.worker.ts) as a real thumbnails track, or does nothing if it
 * doesn't exist (an older session predating this feature, or generation
 * failed — both non-fatal, see the worker's own tolerance for this).
 *
 * `localdir://` URIs only resolve through Shaka's own `NetworkingEngine` —
 * exactly what `registerLocalDirScheme` above wires up for the manifest and
 * every reference Shaka itself fetches (segments, subtitle tracks, ...).
 * The seek bar's own hover-preview `<img>` element isn't one of those: for
 * a plain image (not an mp4-wrapped "mjpg" track), Shaka assigns the raw
 * thumbnail URI straight to `img.src`, which the *browser* then has to
 * resolve — and no browser understands a scheme Shaka invented for itself.
 * Confirmed empirically: the `<img>` gets the right `localdir://...` src
 * and the seek bar's own crop/positioning math all runs correctly, but
 * `naturalWidth` stays 0 forever — a silently broken image, not an error
 * anywhere. Sidestepped by reading the sprite through the folder handle
 * directly here and rewriting the VTT to point at a real `blob:` URL
 * instead, which *is* something every browser can load as an `<img src>`
 * on its own, regardless of which internal path Shaka's seek bar takes to
 * get there.
 */
async function loadThumbnailsTrack(player: shaka.Player, dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const vttText = await (await (await dirHandle.getFileHandle('thumbnails.vtt')).getFile()).text();
    const spriteFile = await (await dirHandle.getFileHandle('thumbnails.jpg')).getFile();
    const spriteUrl = URL.createObjectURL(spriteFile);
    const rewrittenVtt = vttText.replaceAll('thumbnails.jpg', spriteUrl);
    const vttUrl = URL.createObjectURL(new Blob([rewrittenVtt], { type: 'text/vtt' }));
    await player.addThumbnailsTrack(vttUrl, 'text/vtt');
    // Deliberately not revoked: the sprite/VTT blob URLs need to stay valid
    // for the rest of this player's lifetime, and there's no long-running
    // app process here for a per-load leak to accumulate in — the tab
    // going away cleans every blob URL up regardless.
    return true;
  } catch {
    // Optional feature — see this function's own doc comment. Doesn't
    // distinguish "file doesn't exist yet" from any other failure; the
    // caller's own retry loop treats every failure the same way (try again
    // later).
    return false;
  }
}

/** `generateThumbnailSprite` in remux.worker.ts runs as a fire-and-forget
 * background task, deliberately not blocking the main export (see its own
 * comment) — so the sprite may well not exist yet the instant this player
 * first loads, especially for a fast native-remux job that finishes
 * near-instantly while the FFmpeg-based sprite pass is still running.
 *
 * The retry budget used to be a short, fixed ~18s window (5 attempts) —
 * confirmed empirically that generation for even this project's own tiny
 * (2s) test fixture can still be mid-flight by then (each of up to
 * `THUMBNAIL_MAX_TILES` tiles is its own sequential `ffmpeg.exec()` call,
 * with a full FFmpeg-core reload every `FFMPEG_CALLS_PER_INSTANCE` of them —
 * see both in remux.worker.ts), so a real, longer source has no trouble
 * blowing well past 18s. The old behavior wasn't a bug in the generation
 * itself (it always finished, and did land in the exported ZIP once it
 * did) — it just gave up watching for it too early, which reads identically
 * to "thumbnails were never generated" from the UI with no error anywhere
 * to explain why, since nothing actually failed.
 *
 * Retries on a capped-exponential backoff with *no attempt limit* instead —
 * checking is cheap (three tiny OPFS reads), the alternative of guessing
 * another fixed timeout just moves the same failure mode to a longer video,
 * and `isCancelled()` (component unmounted / a new load superseding this
 * one) is still the real stop condition, exactly as before. */
async function loadThumbnailsTrackWithRetry(player: shaka.Player, dirHandle: FileSystemDirectoryHandle, isCancelled: () => boolean): Promise<void> {
  await retryUntilCancelled(() => loadThumbnailsTrack(player, dirHandle), isCancelled, { initialDelayMs: 500, maxDelayMs: 20000 });
}

/**
 * Draws chapter-boundary ticks on the seek bar ourselves, instead of
 * Shaka's own built-in ones (disabled via `seekBarColors.chapters =
 * 'transparent'` where the player is created below — see that call site's
 * own comment for why).
 *
 * Chapters only ever refer to the main content clip, never an attached
 * intro/outro (see lib/chapters.ts's own top comment) — so the *first*
 * chapter's own start and the *last* chapter's own end always land exactly
 * on the intro/outro splice points whenever either is attached, landing
 * strictly inside the real seekable range instead of at its edges. Shaka's
 * own tick logic only ever suppresses a boundary that's at the seek range's
 * own start/end (the normal, no-intro/outro case, where a chapter set
 * spanning the whole video naturally has its own outer edges there too) —
 * it has no way to know the *content's* own start/end have shifted inward,
 * so it drew a real-looking tick at each splice point, which is what
 * actually looked like a separate "intro/outro marker" in the first place.
 * Every other candidate point (a real transition between two chapters the
 * user actually placed) is kept exactly as Shaka's own logic would show it.
 */
function applyChapterTicks(
  container: HTMLElement,
  chapters: shaka.extern.Chapter[],
  seekRange: { start: number; end: number },
  introDurationSec: number,
  outroDurationSec: number,
) {
  const markerContainer = container.querySelector<HTMLElement>('.shaka-chapter-markers');
  if (!markerContainer) return;
  markerContainer.innerHTML = '';

  const span = seekRange.end - seekRange.start;
  if (!(span > 0)) return;

  // The intro/main splice point is at introDurationSec into the real
  // output; the main/outro one is outroDurationSec back from the real end
  // (seekRange.end) — not from the main content's own duration, which this
  // function has no reason to know at all.
  const introBoundarySec = seekRange.start + introDurationSec;
  const outroBoundarySec = seekRange.end - outroDurationSec;
  // Just generous enough to absorb real sub-frame/rounding drift between a
  // client-probed clip duration and what actually lands in the exported
  // manifest's own segment durations (millisecond-scale for a native,
  // stream-copied clip, not the much coarser slop dub-audio's own
  // TOLERANCE_SEC allows for a completely different purpose — whole-track
  // audio/video sync, not splice-point detection) — wide enough for that,
  // deliberately not any wider, so a chapter a user genuinely placed close
  // to the splice point still gets its own real tick instead of being
  // mistaken for the boundary itself.
  const SPLICE_EPSILON_SEC = 0.15;
  const isSpliceBoundary = (t: number) => Math.abs(t - introBoundarySec) < SPLICE_EPSILON_SEC || Math.abs(t - outroBoundarySec) < SPLICE_EPSILON_SEC;

  const points = new Set<number>();
  for (const chapter of chapters) {
    if (chapter.startTime < seekRange.start || chapter.startTime > seekRange.end) continue;
    if (chapter.startTime > seekRange.start && !isSpliceBoundary(chapter.startTime)) points.add(chapter.startTime);
    if (chapter.endTime && chapter.endTime < seekRange.end - 1 && !isSpliceBoundary(chapter.endTime)) points.add(chapter.endTime);
  }

  for (const point of points) {
    const tick = document.createElement('div');
    tick.className = 'player-chapter-tick';
    tick.style.left = `${((point - seekRange.start) / span) * 100}%`;
    markerContainer.appendChild(tick);
  }
}

/**
 * Loads chapter markers (see `writeChaptersVtt` in remux.worker.ts) into
 * Shaka's own chapters track — this is all the wiring needed for the native
 * `ChapterSelection` overflow-menu UI to show up; it appears automatically
 * once `player.getChaptersAsync` returns anything. Unlike thumbnails.vtt,
 * chapters.vtt has no secondary image reference for the *browser* to
 * resolve on its own (see `loadThumbnailsTrack`'s own doc comment for that
 * problem), so the `localdir://` URI is handed straight to Shaka — it's
 * Shaka's own `NetworkingEngine` that fetches it, the same path the
 * manifest/segments/subtitle tracks already go through.
 *
 * A session with no chapters never gets a chapters.vtt written at all (see
 * the worker), so this fails every attempt and gives up silently for those
 * — same "optional, non-fatal" tolerance as thumbnails.
 */
async function loadChaptersTrack(
  player: shaka.Player,
  container: HTMLElement,
  introDurationSec: number,
  outroDurationSec: number,
): Promise<boolean> {
  try {
    await player.addChaptersTrack(`${URI_PREFIX}chapters.vtt`, 'en');
    const chapters = await player.getChaptersAsync('en');
    applyChapterTicks(container, chapters, player.seekRange(), introDurationSec, outroDurationSec);
    return true;
  } catch {
    return false;
  }
}

async function loadChaptersTrackWithRetry(
  player: shaka.Player,
  container: HTMLElement,
  introDurationSec: number,
  outroDurationSec: number,
  isCancelled: () => boolean,
): Promise<void> {
  const RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 8000];
  if (await loadChaptersTrack(player, container, introDurationSec, outroDurationSec)) return;
  for (const delay of RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (isCancelled()) return;
    if (await loadChaptersTrack(player, container, introDurationSec, outroDurationSec)) return;
  }
}

interface PlayerProps {
  m3u8Content: string;
  outputFolderHandle: FileSystemDirectoryHandle | null;
  isComplete: boolean;
  /** When set (e.g. `'manifest.mpd'`), read this DASH manifest directly
   * from `outputFolderHandle` (see `registerLocalDirScheme`) instead of the
   * in-memory `m3u8Content` text the HLS path uses. */
  dashManifestFilename?: string;
  /** An attached intro/outro's own duration, if any — used purely to keep
   * the seek bar's own chapter ticks from misrepresenting the intro/outro
   * splice points as chapter boundaries (see `applyChapterTicks`'s own doc
   * comment). Not needed for anything else here — chapters.vtt itself is
   * already correctly offset by the worker (see writeChaptersVtt). */
  introDurationSec?: number;
  outroDurationSec?: number;
}

export default function Player({ m3u8Content, outputFolderHandle, isComplete, dashManifestFilename, introDurationSec = 0, outroDurationSec = 0 }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const uiRef = useRef<shaka.ui.Overlay | null>(null);
  const manifestContentRef = useRef(m3u8Content);
  manifestContentRef.current = m3u8Content;
  const useDash = !!dashManifestFilename;
  // No live preview during an in-progress conversion — the player only
  // ever loads once the job is actually done, when `m3u8Content` already
  // holds its own final, complete text (see the COMPLETE event handler in
  // useTranscoder.ts, which sets both together).
  const hasContent = isComplete;
  // Which folder handle the current Shaka player was built for, so the
  // effect below only creates a new one for a genuinely new session.
  const loadedHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const destroyPlayer = useCallback(() => {
    void uiRef.current?.destroy();
    uiRef.current = null;
    void playerRef.current?.destroy();
    playerRef.current = null;
    loadedHandleRef.current = null;
  }, []);

  useEffect(() => {
    if (!hasContent || !outputFolderHandle || !videoRef.current || !containerRef.current) return;
    if (loadedHandleRef.current === outputFolderHandle) return;
    loadedHandleRef.current = outputFolderHandle;

    let cancelled = false;

    void (async () => {
      ensurePolyfills();

      if (!shaka.Player.isBrowserSupported()) {
        setPlayerError('This browser cannot play HLS with Shaka Player.');
        return;
      }

      destroyPlayer();
      setPlayerError(null);
      registerLocalDirScheme(outputFolderHandle, () => manifestContentRef.current);

      const player = new shaka.Player();
      await player.attach(videoRef.current!);
      if (cancelled) {
        void player.destroy();
        return;
      }
      playerRef.current = player;

      player.addEventListener('error', (event) => {
        const detail = (event as unknown as { detail?: shaka.util.Error }).detail;
        // Shaka's own `data` array carries the actual diagnostic payload for
        // a given code (e.g. the native MediaError code/message behind a
        // VIDEO_ERROR) — logging just `code {N}` throws that away, leaving
        // nothing to debug from later. Surface it in both places: the
        // console (full object, in case anything in `data` doesn't stringify
        // cleanly) and the on-screen message (so it's visible without
        // DevTools open).
        if (detail) {
          console.error('[Shaka] Playback error', detail);
        }
        const dataSuffix = detail?.data?.length ? ` — ${detail.data.map(String).join(', ')}` : '';
        setPlayerError(`Playback error: ${detail ? `code ${detail.code}${dataSuffix}` : 'unknown error'}`);
      });

      uiRef.current = new shaka.ui.Overlay(player, containerRef.current!, videoRef.current!);
      // Disables Shaka's own built-in chapter-tick rendering (the seek
      // bar's `.shaka-chapter-markers` overlay, colored red by default) —
      // `applyChapterTicks` draws into that exact same element itself,
      // filtered to exclude the intro/outro splice points (see its own doc
      // comment for why those need excluding). Once this config value is
      // transparent, Shaka's own tick logic sets that element blank and
      // stops touching it for good — safe to then own it ourselves.
      uiRef.current.configure({ seekBarColors: { chapters: 'transparent' } });

      try {
        await player.load(useDash ? `${URI_PREFIX}${dashManifestFilename}` : MANIFEST_URI);
        if (cancelled) return;
        videoRef.current?.play().catch(() => {
          // Autoplay may be blocked; the user can press play.
        });
        // Scrubbing-preview thumbnails (see generateThumbnailSprite in
        // remux.worker.ts and loadThumbnailsTrackWithRetry's own doc
        // comment above) — the seek bar's own hover preview picks this up
        // automatically once added, no further wiring needed here.
        void loadThumbnailsTrackWithRetry(player, outputFolderHandle, () => cancelled);
        // Chapter markers (see writeChaptersVtt in remux.worker.ts) — same
        // "appears automatically once added" deal as thumbnails above, this
        // time powering Shaka's Chapters overflow-menu entry (and this
        // component's own seek-bar ticks, see loadChaptersTrack's own doc
        // comment).
        void loadChaptersTrackWithRetry(player, containerRef.current!, introDurationSec, outroDurationSec, () => cancelled);
        // `load()` resolving isn't proof playback actually works: WebKit's
        // MediaSource can silently accept a segment append that never
        // produces decodable data (confirmed against a real MPEG-TS HLS
        // output — no error event, no rejection, the video just sits at
        // readyState HAVE_NOTHING forever). A blank, indefinitely-loading
        // player reads as broken with no explanation; give it one instead
        // of waiting forever for an error that isn't coming. 8s is well
        // past how long a real small segment takes to buffer once load()
        // has already resolved, so this shouldn't fire for a genuinely
        // slow-but-working load.
        const video = videoRef.current;
        const stallTimer = window.setTimeout(() => {
          if (cancelled || !video || video.readyState > 0) return;
          setPlayerError("Playback preview isn't available in this browser for this output — your download will still work.");
        }, 8000);
        video?.addEventListener('loadeddata', () => window.clearTimeout(stallTimer), { once: true });
      } catch (err) {
        if (!cancelled) {
          // Let a later retry attempt happen instead of leaving this
          // session permanently marked "already loaded" after a failure.
          loadedHandleRef.current = null;
          setPlayerError(`Playback error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      destroyPlayer();
    };
    // `introDurationSec`/`outroDurationSec` deliberately excluded — stable
    // for the whole life of a given export result, only ever read once to
    // seed `loadChaptersTrackWithRetry`'s own closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasContent, outputFolderHandle, destroyPlayer, useDash, dashManifestFilename]);

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

  const isReady = isComplete && !!outputFolderHandle;

  return (
    <div className="panel">
      <div className="panel-row panel-row--split">
        <span className="section-label-row">
          <span className="section-label">{useDash ? 'DASH result' : 'HLS result'}</span>
          <span className="preview-badge preview-badge--final">Packaged</span>
        </span>
        {isReady && <span className="status-line is-done">Ready</span>}
      </div>

      {playerError ? (
        <div className="player-error">{playerError}</div>
      ) : (
        <div className="player-frame" ref={containerRef}>
          {isReady ? <video ref={videoRef} /> : <p className="player-placeholder">Your video will play here once the export finishes.</p>}
        </div>
      )}
    </div>
  );
}
