import { useCallback, useRef, useState } from 'react';
import type { TranscodingSession, WorkerCommand, WorkerEvent } from '../types';
import { saveFileToOpfs, deleteOpfsFile } from './usePersistence';
import { createZipBlob } from '../lib/zip';
import RemuxWorker from '../worker/remux.worker.ts?worker';

/** Same probe useTranscoder's own selectFile uses — duplicated rather than
 * shared, since sharing just this one helper isn't worth coupling batch
 * mode's otherwise-independent hook to the single-file one. */
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

export type BatchItemStatus = 'pending' | 'saving' | 'processing' | 'converting' | 'complete' | 'error' | 'cancelled';

export interface BatchQueueItem {
  id: string;
  file: File;
  status: BatchItemStatus;
  segmentProgress: { done: number; total: number };
  convertProgress: number;
  renditionLabel: string;
  error?: string;
  outputFolder?: FileSystemDirectoryHandle;
  isZipping: boolean;
}

/**
 * Batch mode: one shared settings pass (output container, loudness
 * normalization, ABR renditions) applied to N files in sequence, each
 * through the exact same worker pipeline a single file already goes
 * through — just without any of the per-file editing (trim/split,
 * subtitles, intro/outro, dub-audio) the main single-file flow supports.
 * Deliberately its own hook rather than an extension of useTranscoder:
 * that hook's whole state shape (one `session`, one `resumableSession`,
 * IndexedDB checkpointing for pause/resume) is built around exactly one
 * file at a time, and bending it to also track an array of independent
 * jobs would make both harder to follow. No resume support here either —
 * a batch job is short-lived and re-run from scratch on failure, not
 * checkpointed.
 *
 * Files are processed strictly sequentially, one worker at a time: this
 * project's FFmpeg.wasm/WebCodecs pipeline is already resource-heavy for a
 * single job (see runAbrWebCodecsWithHandle's own backpressure handling),
 * and running several concurrently would only contend for the same CPU,
 * memory, and (for ABR) hardware encoder slots.
 */
export function useBatchTranscoder() {
  const [items, setItems] = useState<BatchQueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [outputMode, setOutputModeState] = useState<'opfs' | 'folder'>('opfs');
  const [rootFolder, setRootFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [outputContainer, setOutputContainer] = useState<'ts' | 'fmp4'>('ts');
  const [loudnessNormalization, setLoudnessNormalization] = useState(false);
  const [abrHeights, setAbrHeightsState] = useState<number[]>([]);

  const cancelledRef = useRef(false);
  const activeWorkerRef = useRef<Worker | null>(null);
  // Settles the current item's own processOne() promise — cancelBatch calls
  // this directly rather than only terminating the worker, since terminate()
  // fires neither onmessage nor onerror: without this, the in-flight item
  // would stay stuck at its last status forever and the batch's own for-loop
  // in start() would hang awaiting a promise nothing was ever going to
  // resolve, leaving isRunning stuck true too.
  const activeFinishRef = useRef<(() => void) | null>(null);

  const toggleAbrHeight = useCallback((height: number) => {
    setAbrHeightsState((prev) => (prev.includes(height) ? prev.filter((h) => h !== height) : [...prev, height].sort((a, b) => a - b)));
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<BatchQueueItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setItems((prev) => [
      ...prev,
      ...files.map(
        (file): BatchQueueItem => ({
          id: crypto.randomUUID(),
          file,
          status: 'pending',
          segmentProgress: { done: 0, total: 0 },
          convertProgress: 0,
          renditionLabel: '',
          isZipping: false,
        }),
      ),
    ]);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const selectRootFolder = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setOutputModeState('folder');
      setRootFolder(handle);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    }
  }, []);

  const setOutputMode = useCallback((mode: 'opfs' | 'folder') => {
    setOutputModeState(mode);
    setRootFolder(null);
  }, []);

  /** Runs one queue item's full job to completion (or error/cancel),
   * mirroring useTranscoder's own spawnWorker+start, just scoped to this
   * one item's own state slice instead of a single shared session. */
  const processOne = useCallback(
    (item: BatchQueueItem): Promise<void> => {
      return new Promise((resolve) => {
        void (async () => {
          updateItem(item.id, { status: 'saving' });
          let opfsPath: string;
          let dims: { width: number; height: number; duration: number } | null;
          try {
            [opfsPath, dims] = await Promise.all([saveFileToOpfs(item.file), probeVideoMetadata(item.file)]);
          } catch (err) {
            updateItem(item.id, { status: 'error', error: `Could not read this file: ${err}` });
            resolve();
            return;
          }
          if (cancelledRef.current) {
            updateItem(item.id, { status: 'cancelled' });
            void deleteOpfsFile(opfsPath).catch(() => {});
            resolve();
            return;
          }

          let itemOutputFolder: FileSystemDirectoryHandle;
          try {
            if (outputMode === 'folder' && rootFolder) {
              const slug = item.file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || item.id;
              itemOutputFolder = await rootFolder.getDirectoryHandle(slug, { create: true });
            } else {
              // Must match resolveOutputFolderHandle's own OPFS-mode
              // fallback in remux.worker.ts exactly: with no folder handle
              // in the command (see the WebKit structured-clone comment
              // below), the worker resolves `output_${session.id}` itself
              // rather than receiving one — reading from any other name
              // here would just find an empty directory.
              const opfsRoot = await navigator.storage.getDirectory();
              itemOutputFolder = await opfsRoot.getDirectoryHandle(`output_${item.id}`, { create: true });
            }
          } catch (err) {
            updateItem(item.id, { status: 'error', error: `Could not prepare output: ${err}` });
            void deleteOpfsFile(opfsPath).catch(() => {});
            resolve();
            return;
          }
          updateItem(item.id, { outputFolder: itemOutputFolder, status: 'processing' });

          // Anything above this file's own resolution would only upscale —
          // same filter useTranscoder's own selectFile applies for the
          // single-file flow, just per-item here since a batch's files can
          // each have a different native resolution.
          const validAbrHeights = dims ? abrHeights.filter((h) => h <= dims!.height) : abrHeights;

          const session: TranscodingSession = {
            id: item.id,
            sourceFileName: item.file.name,
            sourceFilePath: opfsPath,
            sourceFileSize: item.file.size,
            lastSegmentIndex: -1,
            totalSegments: 0,
            m3u8Content: '',
            outputFolderHandle: outputMode === 'folder' ? itemOutputFolder : null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sourceWidth: dims?.width,
            sourceHeight: dims?.height,
            sourceDuration: dims?.duration,
            outputContainer,
            loudnessNormalization,
            abrHeights: validAbrHeights.length > 0 ? validAbrHeights : undefined,
          };

          const worker = new RemuxWorker();
          activeWorkerRef.current = worker;

          let settled = false;
          const finish = (patch: Partial<BatchQueueItem>) => {
            if (settled) return;
            settled = true;
            if (activeWorkerRef.current === worker) activeWorkerRef.current = null;
            if (activeFinishRef.current === cancelFinish) activeFinishRef.current = null;
            worker.terminate();
            updateItem(item.id, patch);
            void deleteOpfsFile(opfsPath).catch(() => {});
            resolve();
          };
          const cancelFinish = () => finish({ status: 'cancelled' });
          activeFinishRef.current = cancelFinish;

          worker.onerror = (e) => finish({ status: 'error', error: e.message });
          worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
            const ev = e.data;
            if (ev.type === 'CONVERTING') {
              updateItem(item.id, { status: 'converting', convertProgress: ev.convertProgress ?? 0, renditionLabel: ev.renditionLabel ?? '' });
            }
            if (ev.type === 'INITIALIZED') {
              updateItem(item.id, { status: 'processing', segmentProgress: { done: 0, total: ev.totalSegments ?? 0 } });
            }
            if (ev.type === 'SEGMENT_DONE' && ev.segmentIndex !== undefined) {
              setItems((prev) =>
                prev.map((it) => (it.id === item.id ? { ...it, segmentProgress: { ...it.segmentProgress, done: ev.segmentIndex! + 1 } } : it)),
              );
            }
            if (ev.type === 'COMPLETE') finish({ status: 'complete' });
            if (ev.type === 'ERROR') finish({ status: 'error', error: ev.error ?? 'Unknown error' });
          };

          const cmd: WorkerCommand = {
            type: 'START',
            session,
            outputFolderHandle: outputMode === 'folder' ? itemOutputFolder : undefined,
          };
          try {
            worker.postMessage(cmd);
          } catch (err) {
            finish({ status: 'error', error: `Could not talk to the worker: ${err}` });
          }
        })();
      });
    },
    [outputMode, rootFolder, outputContainer, loudnessNormalization, abrHeights, updateItem],
  );

  const start = useCallback(async () => {
    if (outputMode === 'folder' && !rootFolder) return;
    cancelledRef.current = false;
    setIsRunning(true);
    // Snapshot the queue as it stands right now — items added mid-run join
    // a future run, not this one, matching "start" being an explicit,
    // one-shot action rather than an ever-draining queue.
    const toRun = items.filter((it) => it.status === 'pending' || it.status === 'error' || it.status === 'cancelled');
    for (const item of toRun) {
      if (cancelledRef.current) break;
      await processOne(item);
    }
    setIsRunning(false);
  }, [items, outputMode, rootFolder, processOne]);

  const cancelBatch = useCallback(() => {
    cancelledRef.current = true;
    // Settles the in-flight item's own promise (marking it 'cancelled' and
    // terminating its worker) — see activeFinishRef's own comment for why
    // terminating the worker directly, without this, would leave both that
    // item and the whole batch's start() loop stuck forever.
    activeFinishRef.current?.();
  }, []);

  const downloadItemZip = useCallback(
    async (id: string) => {
      const item = items.find((it) => it.id === id);
      if (!item?.outputFolder) return;
      updateItem(id, { isZipping: true });
      try {
        const blob = await createZipBlob(item.outputFolder);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${item.file.name.replace(/\.[^.]+$/, '') || 'remux-output'}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      } finally {
        updateItem(id, { isZipping: false });
      }
    },
    [items, updateItem],
  );

  const clearBatch = useCallback(() => {
    for (const item of items) {
      if (outputMode === 'opfs' && item.outputFolder) {
        void navigator.storage
          .getDirectory()
          .then((root) => root.removeEntry(`output_${item.id}`, { recursive: true }))
          .catch(() => {});
      }
    }
    setItems([]);
  }, [items, outputMode]);

  const isComplete = items.length > 0 && items.every((it) => it.status === 'complete' || it.status === 'error' || it.status === 'cancelled');
  const canStart = items.length > 0 && !isRunning && (outputMode === 'opfs' || !!rootFolder) && items.some((it) => it.status !== 'complete');

  return {
    items,
    isRunning,
    isComplete,
    canStart,
    outputMode,
    rootFolder,
    outputContainer,
    loudnessNormalization,
    abrHeights,
    addFiles,
    removeItem,
    selectRootFolder,
    setOutputMode,
    setOutputContainer,
    setLoudnessNormalization,
    toggleAbrHeight,
    start,
    cancelBatch,
    downloadItemZip,
    clearBatch,
  };
}
