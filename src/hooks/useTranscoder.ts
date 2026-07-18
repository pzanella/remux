import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, LogEntry, TranscodingSession, WorkerCommand, WorkerEvent } from '../types';
import { saveFileToOpfs, usePersistence } from './usePersistence';
import RemuxWorker from '../worker/remux.worker.ts?worker';

/** Reads intrinsic video dimensions client-side, without touching FFmpeg/OPFS. */
function probeVideoDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const cleanup = () => URL.revokeObjectURL(url);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      cleanup();
    };
    video.onerror = () => {
      resolve(null);
      cleanup();
    };
    video.src = url;
  });
}

/**
 * Owns the whole transcoding lifecycle: worker spawn/teardown, OPFS ingest,
 * session checkpoints, and every piece of state the UI reads. Keeping this
 * out of the components makes each of them a plain, easy-to-read view.
 */
export function useTranscoder() {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [segmentProgress, setSegmentProgress] = useState({ done: 0, total: 0 });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [convertProgress, setConvertProgress] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [session, setSession] = useState<TranscodingSession | null>(null);
  const [resumableSession, setResumableSession] = useState<TranscodingSession | null>(null);
  const [m3u8Preview, setM3u8Preview] = useState('');
  const [masterM3u8Preview, setMasterM3u8Preview] = useState('');
  const [renditionLabel, setRenditionLabel] = useState('');
  const [outputFolder, setOutputFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [sourceResolution, setSourceResolution] = useState<{ width: number; height: number } | null>(null);
  const [abrEnabled, setAbrEnabled] = useState(false);
  const [abrHeights, setAbrHeightsState] = useState<number[]>([]);

  const toggleAbrHeight = useCallback((height: number) => {
    setAbrHeightsState((prev) => (prev.includes(height) ? prev.filter((h) => h !== height) : [...prev, height].sort((a, b) => a - b)));
  }, []);

  const workerRef = useRef<Worker | null>(null);
  const logIdRef = useRef(0);

  const { createSession, updateSession, findResumableSession, deleteSession } = usePersistence();

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, timestamp: Date.now(), message, level }]);
  }, []);

  useEffect(() => {
    findResumableSession().then((s) => {
      if (s) setResumableSession(s);
    });
  }, [findResumableSession]);

  const spawnWorker = useCallback(() => {
    workerRef.current?.terminate();
    const worker = new RemuxWorker();

    worker.onerror = (e) => {
      addLog(`Worker error: ${e.message}`, 'error');
      setStatus('error');
    };

    worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
      const ev = e.data;
      if (ev.log) {
        const level =
          ev.type === 'ERROR' ? 'error' : ev.type === 'COMPLETE' ? 'success' : ev.type === 'PAUSED' ? 'warn' : 'info';
        addLog(ev.log, level);
      }

      if (ev.type === 'CONVERTING') {
        setStatus('converting');
        setConvertProgress(ev.convertProgress ?? 0);
        setRenditionLabel(ev.renditionLabel ?? '');
      }

      if (ev.type === 'INITIALIZED') {
        setStatus('processing');
        setSegmentProgress({ done: 0, total: ev.totalSegments ?? 0 });
      }

      if (ev.type === 'SEGMENT_DONE') {
        if (ev.segmentIndex !== undefined) {
          setSegmentProgress((p) => ({ ...p, done: ev.segmentIndex! + 1 }));
        }
        if (ev.m3u8) setM3u8Preview(ev.m3u8);

        if (ev.sessionId && ev.segmentIndex !== undefined) {
          setSession((prev) => {
            if (!prev) return prev;
            const next: TranscodingSession = {
              ...prev,
              lastSegmentIndex: ev.segmentIndex!,
              m3u8Content: ev.m3u8 ?? prev.m3u8Content,
            };
            updateSession(next);
            return next;
          });
        }
      }

      if (ev.type === 'COMPLETE') {
        setStatus('complete');
        if (ev.m3u8) setM3u8Preview(ev.m3u8);
        if (ev.masterM3u8) setMasterM3u8Preview(ev.masterM3u8);
        if (ev.sessionId) deleteSession(ev.sessionId);
      }

      if (ev.type === 'ERROR') {
        setStatus('error');
        if (!ev.log) addLog(ev.error ?? 'Unknown worker error', 'error');
      }

      if (ev.type === 'PAUSED') {
        setStatus('paused');
      }
    };

    workerRef.current = worker;
    return worker;
  }, [addLog, updateSession, deleteSession]);

  const selectFile = useCallback(
    async (file: File) => {
      setStatus('saving-to-opfs');
      setUploadProgress(0);
      addLog(`Selected ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MiB)`);

      try {
        const [opfsPath, dims] = await Promise.all([
          saveFileToOpfs(file, (loaded, total) => {
            setUploadProgress(Math.round((loaded / total) * 100));
          }),
          probeVideoDimensions(file),
        ]);
        const newSession = await createSession(file.name, opfsPath, file.size, 0, outputFolder);
        setSession({ ...newSession, sourceWidth: dims?.width, sourceHeight: dims?.height });
        setSourceResolution(dims);
        setAbrHeightsState((prev) => (dims ? prev.filter((h) => h <= dims.height) : prev));
        setStatus('idle');
        addLog('Ready. Press Start when you are.', 'success');
      } catch (err) {
        setStatus('error');
        addLog(`Could not save the file: ${err}`, 'error');
      }
    },
    [addLog, createSession, outputFolder],
  );

  const selectOutputFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setOutputFolder(handle);
      addLog(`Output folder: ${handle.name}`, 'success');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        addLog(`Could not open the folder: ${err}`, 'error');
      }
    }
  }, [addLog]);

  const start = useCallback(() => {
    if (!session || !outputFolder) return;

    setStatus('processing');
    setSegmentProgress({ done: 0, total: 0 });
    setConvertProgress(0);
    setMasterM3u8Preview('');
    setLogs([]);
    addLog(abrEnabled && abrHeights.length > 0 ? `Starting adaptive HLS (${abrHeights.join(', ')}p)…` : 'Starting…');

    const worker = spawnWorker();
    const cmd: WorkerCommand = {
      type: 'START',
      session: {
        ...session,
        outputFolderHandle: outputFolder,
        abrHeights: abrEnabled && abrHeights.length > 0 ? abrHeights : undefined,
      },
      outputFolderHandle: outputFolder,
    };
    try {
      worker.postMessage(cmd);
    } catch (err) {
      setStatus('error');
      addLog(`Could not talk to the worker: ${err}`, 'error');
    }
  }, [session, outputFolder, abrEnabled, abrHeights, addLog, spawnWorker]);

  const resume = useCallback(async () => {
    const src = resumableSession ?? session;
    if (!src || !outputFolder) return;

    setStatus('processing');
    addLog(`Resuming from segment ${src.lastSegmentIndex + 2}…`);

    const worker = spawnWorker();
    const cmd: WorkerCommand = {
      type: 'RESUME',
      session: { ...src, outputFolderHandle: outputFolder },
      outputFolderHandle: outputFolder,
    };
    try {
      worker.postMessage(cmd);
    } catch (err) {
      setStatus('error');
      addLog(`Could not talk to the worker: ${err}`, 'error');
      return;
    }
    setSession(src);
    setResumableSession(null);
  }, [resumableSession, session, outputFolder, addLog, spawnWorker]);

  const pause = useCallback(() => {
    workerRef.current?.postMessage({ type: 'PAUSE' } as WorkerCommand);
  }, []);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: 'CANCEL' } as WorkerCommand);
    workerRef.current?.terminate();
    workerRef.current = null;
    setStatus('idle');
    addLog('Cancelled.', 'warn');
  }, [addLog]);

  const dismissResume = useCallback(async () => {
    if (resumableSession) {
      await deleteSession(resumableSession.id);
      setResumableSession(null);
    }
  }, [resumableSession, deleteSession]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const isRunning = status === 'processing' || status === 'converting';
  const canStart = !!session && !!outputFolder && !isRunning && status !== 'complete';
  const canResume =
    (!!resumableSession || (!!session && (session.lastSegmentIndex ?? -1) >= 0)) && !!outputFolder && !isRunning;

  return {
    status,
    logs,
    session,
    resumableSession,
    outputFolder,
    uploadProgress,
    convertProgress,
    segmentProgress,
    m3u8Preview,
    masterM3u8Preview,
    renditionLabel,
    sourceResolution,
    abrEnabled,
    abrHeights,
    isRunning,
    canStart,
    canResume,
    selectFile,
    selectOutputFolder,
    setAbrEnabled,
    toggleAbrHeight,
    start,
    resume,
    pause,
    cancel,
    dismissResume,
    clearLogs,
  };
}
