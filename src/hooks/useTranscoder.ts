import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, LogEntry, TranscodingSession, WorkerCommand, WorkerEvent } from '../types';
import { saveFileToOpfs, writeOpfsTextFile, usePersistence } from './usePersistence';
import { createZipBlob } from '../lib/zip';
import { isTrivialEdit } from '../lib/segments';
import RemuxWorker from '../worker/remux.worker.ts?worker';

/** An intro/outro clip's OPFS pointer plus everything the timeline needs to
 * draw and preview it, without re-reading the file. */
export interface ClipFile {
  fileName: string;
  label: string;
  width?: number;
  height?: number;
  duration?: number;
  file: File;
}

/** Reads intrinsic video dimensions and duration client-side, without
 * touching FFmpeg/OPFS — duration feeds the timeline's proportional clip
 * widths and the subtitle intro-offset shift. */
function probeVideoMetadata(file: File): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const cleanup = () => URL.revokeObjectURL(url);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
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
  /**
   * 'opfs' (default) needs no picker at all — output goes to a private,
   * origin-scoped directory the browser already grants access to, same as
   * the source file's own OPFS staging. 'folder' is the original flow: a
   * real on-disk folder via `showDirectoryPicker`, for anyone who wants the
   * files to land somewhere they can see them without an extra step.
   */
  const [outputMode, setOutputModeState] = useState<'opfs' | 'folder'>('opfs');
  /** Fast-path output container. 'fmp4' only supports the plain
   * single-quality case (see the outputContainer guards in
   * remux.worker.ts's runTranscoding) — the worker rejects it clearly if
   * ABR/edited-segments/dub-audio/subtitles/intro-outro are also present,
   * rather than this hook trying to pre-emptively cross-disable every
   * combination across several unrelated components. */
  const [outputContainer, setOutputContainer] = useState<'ts' | 'fmp4'>('ts');
  const [sourceResolution, setSourceResolution] = useState<{ width: number; height: number } | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | undefined>(undefined);
  /** Kept only for the timeline's raw (pre-conversion) clip preview — never
   * persisted, never sent to the worker (which reads from OPFS by name). */
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [abrEnabled, setAbrEnabled] = useState(false);
  const [abrHeights, setAbrHeightsState] = useState<number[]>([]);
  const [subtitleTracks, setSubtitleTracksState] = useState<{ fileName: string; label: string; language: string }[]>([]);
  /** Each track's current subtitle content as editable text, keyed by its
   * OPFS filename — kept alongside `subtitleTracks` (which is just the
   * OPFS pointer + display metadata per track) so the cue editor has
   * something to show immediately without a round trip through OPFS. */
  const [subtitleVttTextByFile, setSubtitleVttTextByFile] = useState<Record<string, string>>({});
  const [introFile, setIntroFileState] = useState<ClipFile | null>(null);
  const [outroFile, setOutroFileState] = useState<ClipFile | null>(null);
  const [dubAudioTracks, setDubAudioTracksState] = useState<{ fileName: string; label: string; language: string }[]>([]);
  const [isZipping, setIsZipping] = useState(false);

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
          probeVideoMetadata(file),
        ]);
        const newSession = await createSession(file.name, opfsPath, file.size, 0, outputFolder);
        setSession({ ...newSession, sourceWidth: dims?.width, sourceHeight: dims?.height, sourceDuration: dims?.duration });
        setSourceResolution(dims);
        setSourceDuration(dims?.duration);
        setSourceFile(file);
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

  const selectSubtitleFile = useCallback(
    async (file: File) => {
      try {
        const [opfsPath, text] = await Promise.all([saveFileToOpfs(file), file.text()]);
        const label = file.name.replace(/\.(srt|vtt)$/i, '');
        setSubtitleTracksState((prev) => [...prev, { fileName: opfsPath, label, language: 'en' }]);
        setSubtitleVttTextByFile((prev) => ({ ...prev, [opfsPath]: text }));
        addLog(`Subtitles: ${file.name}`, 'success');
      } catch (err) {
        addLog(`Could not save the subtitle file: ${err}`, 'error');
      }
    },
    [addLog],
  );

  // Mints a fresh, empty subtitle track and writes a minimal valid VTT file
  // for it immediately — the "write from scratch" flow's starting point.
  // Written eagerly (rather than lazily on first save, the single-track
  // version's approach) so every entry in `subtitleTracks` always has a
  // real OPFS file behind it, even if the cue editor is opened and closed
  // without adding a single cue. Returns the new filename so the caller
  // can open the cue editor for this specific track right away.
  const addBlankSubtitleTrack = useCallback(async (): Promise<string | null> => {
    const fileName = `subtitles_${Date.now()}.vtt`;
    const emptyVtt = 'WEBVTT\n\n';
    try {
      await writeOpfsTextFile(fileName, emptyVtt);
      setSubtitleTracksState((prev) => [...prev, { fileName, label: 'Subtitles', language: 'en' }]);
      setSubtitleVttTextByFile((prev) => ({ ...prev, [fileName]: emptyVtt }));
      return fileName;
    } catch (err) {
      addLog(`Could not create a new subtitle track: ${err}`, 'error');
      return null;
    }
  }, [addLog]);

  const setSubtitleTrackLanguage = useCallback((fileName: string, language: string) => {
    setSubtitleTracksState((prev) => prev.map((t) => (t.fileName === fileName ? { ...t, language } : t)));
  }, []);

  const removeSubtitleTrack = useCallback((fileName: string) => {
    setSubtitleTracksState((prev) => prev.filter((t) => t.fileName !== fileName));
    setSubtitleVttTextByFile((prev) => {
      if (!(fileName in prev)) return prev;
      const next = { ...prev };
      delete next[fileName];
      return next;
    });
  }, []);

  // Writes edited cue text back to the given track's own OPFS filename, so
  // the worker's reference to it stays valid across edits.
  const saveSubtitleEdits = useCallback(
    async (fileName: string, vttText: string) => {
      try {
        await writeOpfsTextFile(fileName, vttText);
        setSubtitleVttTextByFile((prev) => ({ ...prev, [fileName]: vttText }));
        addLog('Subtitles updated.', 'success');
      } catch (err) {
        addLog(`Could not save subtitle edits: ${err}`, 'error');
      }
    },
    [addLog],
  );

  const selectIntroFile = useCallback(
    async (file: File) => {
      try {
        const [opfsPath, dims] = await Promise.all([saveFileToOpfs(file), probeVideoMetadata(file)]);
        setIntroFileState({ fileName: opfsPath, label: file.name, width: dims?.width, height: dims?.height, duration: dims?.duration, file });
        addLog(`Intro: ${file.name}`, 'success');
      } catch (err) {
        addLog(`Could not save the intro file: ${err}`, 'error');
      }
    },
    [addLog],
  );
  const clearIntroFile = useCallback(() => setIntroFileState(null), []);

  const selectOutroFile = useCallback(
    async (file: File) => {
      try {
        const [opfsPath, dims] = await Promise.all([saveFileToOpfs(file), probeVideoMetadata(file)]);
        setOutroFileState({ fileName: opfsPath, label: file.name, width: dims?.width, height: dims?.height, duration: dims?.duration, file });
        addLog(`Outro: ${file.name}`, 'success');
      } catch (err) {
        addLog(`Could not save the outro file: ${err}`, 'error');
      }
    },
    [addLog],
  );
  const clearOutroFile = useCallback(() => setOutroFileState(null), []);

  const selectDubAudioTrack = useCallback(
    async (file: File) => {
      try {
        // `<video>` reads .duration for audio-only files fine (it's really
        // an <audio> capable element too) — reused here just for that,
        // width/height come back 0 and are ignored.
        const dims = await probeVideoMetadata(file);
        // A dub shorter than the main content produces a media playlist
        // with fewer segments than the video's — real-world HLS players
        // (Shaka included) expect every rendition in the same #EXT-X-MEDIA
        // group to span the same duration, and choke on the mismatch once
        // playback reaches the point where the shorter track has run out
        // but the video hasn't (confirmed against a real Shaka VIDEO_ERROR
        // this way). Properly fixing this means padding the gap with
        // synthesized silence, which isn't implemented yet — rejecting the
        // file here is what stands between that and shipping a conversion
        // that looks like it succeeded but produces broken playback.
        const TOLERANCE_SEC = 0.5;
        if (sourceDuration !== undefined && dims && dims.duration < sourceDuration - TOLERANCE_SEC) {
          addLog(
            `Dub audio "${file.name}" (${dims.duration.toFixed(1)}s) is shorter than the main content ` +
              `(${sourceDuration.toFixed(1)}s) — not supported yet, it would produce broken playback. Trim the main ` +
              `content to match, or use a dub at least as long.`,
            'error',
          );
          return;
        }
        const opfsPath = await saveFileToOpfs(file);
        const label = file.name.replace(/\.[^.]+$/, '');
        setDubAudioTracksState((prev) => [...prev, { fileName: opfsPath, label, language: 'en' }]);
        addLog(`Dub audio: ${file.name}`, 'success');
      } catch (err) {
        addLog(`Could not save the dub audio file: ${err}`, 'error');
      }
    },
    [addLog, sourceDuration],
  );
  const removeDubAudioTrack = useCallback((fileName: string) => {
    setDubAudioTracksState((prev) => prev.filter((t) => t.fileName !== fileName));
  }, []);
  const setDubAudioTrackLanguage = useCallback((fileName: string, language: string) => {
    setDubAudioTracksState((prev) => prev.map((t) => (t.fileName === fileName ? { ...t, language } : t)));
  }, []);

  const selectOutputFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setOutputModeState('folder');
      setOutputFolder(handle);
      addLog(`Output folder: ${handle.name}`, 'success');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        addLog(`Could not open the folder: ${err}`, 'error');
      }
    }
  }, [addLog]);

  const setOutputMode = useCallback((mode: 'opfs' | 'folder') => {
    setOutputModeState(mode);
    // Both directions need a fresh resolve: 'folder' must wait for an
    // explicit pick (can't silently reuse a stale handle), and 'opfs' must
    // re-derive its directory for whichever session is now current.
    setOutputFolder(null);
  }, []);

  // Auto-resolves the OPFS output directory — no picker, no permission
  // prompt needed. Keyed off the session id (not created fresh each time)
  // so a Resume after a reload finds the same directory and its
  // already-written segments, the same way folder-mode resume finds them
  // by the user re-picking the same real folder.
  useEffect(() => {
    if (outputMode !== 'opfs' || outputFolder) return;
    const sessionId = session?.id ?? resumableSession?.id;
    if (!sessionId) return;

    let cancelled = false;
    void (async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        const dirHandle = await opfsRoot.getDirectoryHandle(`output_${sessionId}`, { create: true });
        if (!cancelled) setOutputFolder(dirHandle);
      } catch (err) {
        if (!cancelled) addLog(`Could not prepare browser storage: ${err}`, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [outputMode, session?.id, resumableSession?.id, outputFolder, addLog]);

  const start = useCallback((editorSegments?: { sourceStart: number; sourceEnd: number }[]) => {
    if (!session || !outputFolder) return;

    setStatus('processing');
    setSegmentProgress({ done: 0, total: 0 });
    setConvertProgress(0);
    setMasterM3u8Preview('');
    setLogs([]);
    addLog(abrEnabled && abrHeights.length > 0 ? `Starting adaptive HLS (${abrHeights.join(', ')}p)…` : 'Starting…');

    const isAbrJob = abrEnabled && abrHeights.length > 0;
    const introOutro =
      introFile || outroFile
        ? {
            introFileName: introFile?.fileName,
            introWidth: introFile?.width,
            introHeight: introFile?.height,
            introDuration: introFile?.duration,
            outroFileName: outroFile?.fileName,
            outroWidth: outroFile?.width,
            outroHeight: outroFile?.height,
          }
        : undefined;

    // Fold the subtitle/intro/outro selections into the session itself (not
    // just the outgoing worker command) so they round-trip through
    // IndexedDB and survive a Resume, the same way abrHeights already does
    // implicitly.
    const sessionWithExtras: TranscodingSession = {
      ...session,
      subtitleTracks: subtitleTracks.length > 0 ? subtitleTracks : undefined,
      introOutro,
      dubAudioTracks: dubAudioTracks.length > 0 ? dubAudioTracks : undefined,
      segments: editorSegments,
      outputContainer,
    };
    setSession(sessionWithExtras);

    // WebKit can't structured-clone a FileSystemDirectoryHandle across
    // postMessage at all (confirmed empirically — DataCloneError, even for
    // one sourced from OPFS itself), so an OPFS-mode handle is withheld
    // here on purpose: the worker resolves the identical `output_${id}`
    // directory itself instead (see resolveOutputFolderHandle). A real
    // user-picked folder has no such alternative — it only exists because
    // of a permission grant made on this thread — so it still has to be
    // sent, which is fine since that mode is Chromium-only anyway (it
    // needs showDirectoryPicker) and Chromium has no cloning restriction.
    const handleForWorker = outputMode === 'folder' ? outputFolder : null;
    const worker = spawnWorker();
    const cmd: WorkerCommand = {
      type: 'START',
      session: {
        ...sessionWithExtras,
        outputFolderHandle: handleForWorker,
        abrHeights: isAbrJob ? abrHeights : undefined,
      },
      outputFolderHandle: handleForWorker ?? undefined,
    };
    try {
      worker.postMessage(cmd);
    } catch (err) {
      setStatus('error');
      addLog(`Could not talk to the worker: ${err}`, 'error');
    }
  }, [session, outputFolder, outputMode, outputContainer, abrEnabled, abrHeights, subtitleTracks, introFile, outroFile, dubAudioTracks, addLog, spawnWorker]);

  const resume = useCallback(async () => {
    const src = resumableSession ?? session;
    if (!src || !outputFolder) return;

    setStatus('processing');
    addLog(`Resuming from segment ${src.lastSegmentIndex + 2}…`);

    const handleForWorker = outputMode === 'folder' ? outputFolder : null;
    const worker = spawnWorker();
    const cmd: WorkerCommand = {
      type: 'RESUME',
      session: { ...src, outputFolderHandle: handleForWorker },
      outputFolderHandle: handleForWorker ?? undefined,
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
  }, [resumableSession, session, outputFolder, outputMode, addLog, spawnWorker]);

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

  // Tears down everything so a new video can be picked from a clean slate —
  // stops any in-flight worker, drops the IndexedDB checkpoint(s) and their
  // OPFS source file(s) the same way a normal completion already does, and
  // clears the OPFS output directory too (only when it's actually ours —
  // never touches a user-picked real folder in 'folder' mode).
  const reset = useCallback(async () => {
    workerRef.current?.postMessage({ type: 'CANCEL' } as WorkerCommand);
    workerRef.current?.terminate();
    workerRef.current = null;

    if (session) await deleteSession(session.id);
    if (resumableSession && resumableSession.id !== session?.id) await deleteSession(resumableSession.id);

    if (outputMode === 'opfs' && session) {
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        await opfsRoot.removeEntry(`output_${session.id}`, { recursive: true });
      } catch {
        // Already gone, or never created — fine either way.
      }
    }

    setStatus('idle');
    setSession(null);
    setResumableSession(null);
    setUploadProgress(0);
    setConvertProgress(0);
    setSegmentProgress({ done: 0, total: 0 });
    setLogs([]);
    setM3u8Preview('');
    setMasterM3u8Preview('');
    setRenditionLabel('');
    setOutputFolder(null);
    setSourceResolution(null);
    setSourceDuration(undefined);
    setSourceFile(null);
    setAbrEnabled(false);
    setAbrHeightsState([]);
    setSubtitleTracksState([]);
    setSubtitleVttTextByFile({});
    setIntroFileState(null);
    setOutroFileState(null);
    setDubAudioTracksState([]);
    setIsZipping(false);
  }, [session, resumableSession, outputMode, deleteSession]);

  const downloadZip = useCallback(async () => {
    if (!outputFolder) return;
    setIsZipping(true);
    addLog('Zipping output…');
    try {
      const blob = await createZipBlob(outputFolder);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${session?.sourceFileName.replace(/\.[^.]+$/, '') || 'remux-output'}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      addLog('Download ready.', 'success');
    } catch (err) {
      addLog(`Could not build the ZIP: ${err}`, 'error');
    } finally {
      setIsZipping(false);
    }
  }, [outputFolder, session, addLog]);

  // A session with a real (non-trivial) edited segment list, like an ABR
  // job, isn't checkpointed mid-export — resuming it would replay
  // runWithHandle's whole-file per-.ts-segment logic against a job that
  // never took that path in the first place. See hasEditedSegments in
  // remux.worker.ts for the worker-side twin of this check.
  const hasNonResumableEdit = (s: TranscodingSession | null) =>
    !!s?.segments?.length && !(s.sourceDuration !== undefined && isTrivialEdit(s.segments, s.sourceDuration));

  const isRunning = status === 'processing' || status === 'converting';
  const canStart = !!session && !!outputFolder && !isRunning && status !== 'complete';
  const canResume =
    (!!resumableSession || (!!session && (session.lastSegmentIndex ?? -1) >= 0)) &&
    !!outputFolder &&
    !isRunning &&
    !hasNonResumableEdit(resumableSession) &&
    !hasNonResumableEdit(session);

  return {
    status,
    logs,
    session,
    resumableSession,
    outputFolder,
    outputMode,
    outputContainer,
    uploadProgress,
    convertProgress,
    segmentProgress,
    m3u8Preview,
    masterM3u8Preview,
    renditionLabel,
    sourceResolution,
    sourceDuration,
    sourceFile,
    abrEnabled,
    abrHeights,
    subtitleTracks,
    subtitleVttTextByFile,
    introFile,
    outroFile,
    dubAudioTracks,
    isRunning,
    canStart,
    canResume,
    selectFile,
    selectOutputFolder,
    setOutputMode,
    setOutputContainer,
    selectSubtitleFile,
    addBlankSubtitleTrack,
    saveSubtitleEdits,
    selectIntroFile,
    clearIntroFile,
    selectOutroFile,
    clearOutroFile,
    selectDubAudioTrack,
    removeDubAudioTrack,
    setDubAudioTrackLanguage,
    removeSubtitleTrack,
    setSubtitleTrackLanguage,
    setAbrEnabled,
    toggleAbrHeight,
    start,
    resume,
    pause,
    cancel,
    dismissResume,
    clearLogs,
    downloadZip,
    isZipping,
    reset,
  };
}
