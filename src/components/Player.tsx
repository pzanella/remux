/**
 * In-browser HLS playback with hls.js, reading segments straight from a
 * FileSystemDirectoryHandle — no server needed. A custom loader intercepts
 * every request: `.m3u8`/key requests go through fetch() on the blob URL we
 * create ourselves; `.ts` segment requests are resolved by filename against
 * the local output folder (hls.js resolves segment URLs relative to the
 * blob URL, which produces a non-fetchable blob:.../segment_0000.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { LoaderCallbacks, LoaderContext, LoaderStats, LoaderConfiguration } from 'hls.js';

type HlsClass = typeof import('hls.js').default;

let _hlsClass: HlsClass | null = null;
async function loadHlsClass(): Promise<HlsClass> {
  if (!_hlsClass) {
    _hlsClass = (await import('hls.js')).default;
  }
  return _hlsClass;
}

function createLocalLoader(dirHandle: FileSystemDirectoryHandle) {
  return class LocalFileLoader {
    private _cancelled = false;

    context: LoaderContext | null = null;
    stats: LoaderStats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };

    load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      const url = context.url;
      const filename = url.split('/').pop()?.split('?')[0] ?? url;

      this.stats.loading.start = performance.now();

      void (async () => {
        try {
          if (this._cancelled) return;

          let data: string | ArrayBuffer;
          if (filename.endsWith('.ts') || filename.endsWith('.m2ts')) {
            const fileHandle = await dirHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            data = await file.arrayBuffer();
          } else {
            const resp = await fetch(url);
            data = await resp.text();
          }

          if (this._cancelled) return;

          this.stats.loading.end = performance.now();
          this.stats.loaded = typeof data === 'string' ? data.length : data.byteLength;
          this.stats.total = this.stats.loaded;

          callbacks.onSuccess({ data, url, code: 200 }, this.stats, context, null);
        } catch (err) {
          if (!this._cancelled) {
            callbacks.onError({ code: 0, text: String(err) }, context, null, this.stats);
          }
        }
      })();
    }

    abort(): void {
      this._cancelled = true;
    }

    destroy(): void {
      this._cancelled = true;
    }
  };
}

interface PlayerProps {
  m3u8Content: string;
  outputFolderHandle: FileSystemDirectoryHandle | null;
  isComplete: boolean;
}

export default function Player({ m3u8Content, outputFolderHandle, isComplete }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const destroyHls = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!m3u8Content || !outputFolderHandle || !videoRef.current) return;

    let cancelled = false;

    void (async () => {
      const HlsClass = await loadHlsClass();
      if (cancelled) return;

      if (!HlsClass.isSupported()) {
        setPlayerError('This browser cannot play HLS with hls.js.');
        return;
      }

      destroyHls();
      setPlayerError(null);

      const blob = new Blob([m3u8Content], { type: 'application/vnd.apple.mpegurl' });
      const blobUrl = URL.createObjectURL(blob);
      blobUrlRef.current = blobUrl;

      const hls = new HlsClass({
        loader: createLocalLoader(outputFolderHandle),
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: false,
      });

      hls.on(HlsClass.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setPlayerError(`Playback error: ${data.details}`);
          destroyHls();
        }
      });

      hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
        videoRef.current?.play().catch(() => {
          // Autoplay may be blocked; the user can press play.
        });
      });

      hls.loadSource(blobUrl);
      hls.attachMedia(videoRef.current!);
      hlsRef.current = hls;
    })();

    return () => {
      cancelled = true;
      destroyHls();
    };
  }, [m3u8Content, outputFolderHandle, destroyHls]);

  useEffect(() => () => destroyHls(), [destroyHls]);

  const isReady = m3u8Content && outputFolderHandle;

  return (
    <div className="panel">
      <div className="panel-row panel-row--split">
        <span className="section-label">Preview</span>
        {isReady && (
          <span className={`status-line ${isComplete ? 'is-done' : 'is-active'}`}>
            {isComplete ? 'Ready' : 'Playing live while it converts'}
          </span>
        )}
      </div>

      {playerError ? (
        <div className="player-error">{playerError}</div>
      ) : (
        <div className="player-frame">
          {isReady ? (
            <video ref={videoRef} controls />
          ) : (
            <p className="player-placeholder">Your video will play here once the first segment is ready.</p>
          )}
        </div>
      )}
    </div>
  );
}
