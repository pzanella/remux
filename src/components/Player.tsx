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
}

export default function Player({ m3u8Content, outputFolderHandle, isComplete }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const uiRef = useRef<shaka.ui.Overlay | null>(null);
  const manifestContentRef = useRef(m3u8Content);
  manifestContentRef.current = m3u8Content;
  const [playerError, setPlayerError] = useState<string | null>(null);

  const destroyPlayer = useCallback(() => {
    void uiRef.current?.destroy();
    uiRef.current = null;
    void playerRef.current?.destroy();
    playerRef.current = null;
  }, []);

  useEffect(() => {
    if (!m3u8Content || !outputFolderHandle || !videoRef.current || !containerRef.current) return;

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
        setPlayerError(`Playback error: ${detail ? `code ${detail.code}` : 'unknown error'}`);
      });

      uiRef.current = new shaka.ui.Overlay(player, containerRef.current!, videoRef.current!);

      try {
        await player.load(MANIFEST_URI);
        if (cancelled) return;
        videoRef.current?.play().catch(() => {
          // Autoplay may be blocked; the user can press play.
        });
      } catch (err) {
        if (!cancelled) {
          setPlayerError(`Playback error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      destroyPlayer();
    };
  }, [m3u8Content, outputFolderHandle, destroyPlayer]);

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

  const isReady = m3u8Content && outputFolderHandle;

  return (
    <div className="panel">
      <div className="panel-row panel-row--split">
        <span className="section-label-row">
          <span className="section-label">HLS result</span>
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
            <p className="player-placeholder">Your video will play here once the first segment is ready.</p>
          )}
        </div>
      )}
    </div>
  );
}
