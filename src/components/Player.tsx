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

interface PlayerProps {
  m3u8Content: string;
  outputFolderHandle: FileSystemDirectoryHandle | null;
  isComplete: boolean;
  /**
   * When set (e.g. `'manifest.mpd'`), preview via this DASH manifest
   * instead of the HLS live-preview flow below — read directly from
   * `outputFolderHandle` once the job is done, the same way any other
   * referenced file already is (see `registerLocalDirScheme`), rather
   * than through `manifestContentRef`'s in-memory text: unlike the HLS
   * media playlist, this project's DASH manifest is only ever written
   * once, at the very end (see runFmp4FastPath), so there's no
   * in-progress version to track live.
   */
  dashManifestFilename?: string;
}

export default function Player({ m3u8Content, outputFolderHandle, isComplete, dashManifestFilename }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const uiRef = useRef<shaka.ui.Overlay | null>(null);
  const manifestContentRef = useRef(m3u8Content);
  manifestContentRef.current = m3u8Content;
  const useDash = !!dashManifestFilename;
  // Only whether there's *any* content yet, not the string itself, drives
  // the load effect below — see its dependency array for why. DASH has no
  // such string to watch (see `dashManifestFilename` above), so "ready"
  // just means "the job is done".
  const hasContent = useDash ? isComplete : m3u8Content.length > 0;
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

      try {
        await player.load(useDash ? `${URI_PREFIX}${dashManifestFilename}` : MANIFEST_URI);
        if (cancelled) return;
        videoRef.current?.play().catch(() => {
          // Autoplay may be blocked; the user can press play.
        });
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
          setPlayerError("Live preview isn't available in this browser for this output yet — your download will still work once conversion finishes.");
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
    // `hasContent`, not `m3u8Content` itself, is the dependency on purpose:
    // a live conversion updates `m3u8Content` on every segment (often
    // several times within ~100ms right around completion, confirmed
    // empirically), and depending on the raw string would tear this whole
    // effect's player down and rebuild it on every single tick. That's not
    // just wasteful, it hangs WebKit outright: destroying one Shaka player
    // and immediately attaching a new one to the same <video> element in
    // rapid succession never resolves there (confirmed against real WebKit
    // — `player.attach()` simply never settles on the second attempt),
    // leaving a permanently blank preview with no error. None of that
    // rebuilding is needed for a same-session content update anyway:
    // `manifestContentRef` above already serves the latest content to
    // Shaka's own scheme plugin, and Shaka re-fetches a still-live manifest
    // on its own timer. `hasContent` only flips once, false→true, the
    // moment there's anything to load at all — which is the one transition
    // that actually needs a fresh player.
  }, [hasContent, outputFolderHandle, destroyPlayer, useDash, dashManifestFilename]);

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

  const isReady = !!((useDash ? isComplete : m3u8Content) && outputFolderHandle);

  return (
    <div className="panel">
      <div className="panel-row panel-row--split">
        <span className="section-label-row">
          <span className="section-label">{useDash ? 'DASH result' : 'HLS result'}</span>
          <span className="preview-badge preview-badge--final">Packaged</span>
        </span>
        {isReady && (
          <span className={`status-line ${isComplete ? 'is-done' : 'is-active'}`}>
            {isComplete ? 'Ready' : 'Playing live while it converts'}
          </span>
        )}
      </div>

      {playerError ? (
        <div className="player-error">{playerError}</div>
      ) : (
        <div className="player-frame" ref={containerRef}>
          {isReady ? (
            <video ref={videoRef} />
          ) : (
            <p className="player-placeholder">
              {useDash ? 'Your video will play here once the DASH manifest is ready.' : 'Your video will play here once the first segment is ready.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
