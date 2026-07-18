/**
 * IndexedDB session checkpoints + OPFS source-file storage.
 * DB "hls-transcoder" v1, store "sessions" (keyPath: id).
 */
import { useCallback } from 'react';
import type { TranscodingSession } from '../types';

const DB_NAME = 'hls-transcoder';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, record: TranscodingSession): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, id: string): Promise<TranscodingSession | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result as TranscodingSession | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db: IDBDatabase): Promise<TranscodingSession[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as TranscodingSession[]);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** Stream a File into OPFS in 4 MiB chunks and return its OPFS filename. */
export async function saveFileToOpfs(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  const root = await getOpfsRoot();
  const opfsName = `src_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const fh = await root.getFileHandle(opfsName, { create: true });
  const writable = await fh.createWritable();

  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK);
    const buf = await slice.arrayBuffer();
    await writable.write({ type: 'write', position: offset, data: buf });
    offset += buf.byteLength;
    onProgress?.(offset, file.size);
  }
  await writable.close();
  return opfsName;
}

export async function deleteOpfsFile(opfsName: string): Promise<void> {
  const root = await getOpfsRoot();
  await root.removeEntry(opfsName);
}

export function usePersistence() {
  const createSession = useCallback(
    async (
      sourceFileName: string,
      opfsPath: string,
      sourceFileSize: number,
      totalSegments: number,
      outputFolderHandle: FileSystemDirectoryHandle | null,
    ): Promise<TranscodingSession> => {
      const session: TranscodingSession = {
        id: crypto.randomUUID(),
        sourceFileName,
        sourceFilePath: opfsPath,
        sourceFileSize,
        lastSegmentIndex: -1,
        totalSegments,
        segmentDurations: [],
        m3u8Content: '',
        outputFolderHandle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const db = await openDb();
      await idbPut(db, session);
      db.close();
      return session;
    },
    [],
  );

  const updateSession = useCallback(async (session: TranscodingSession): Promise<void> => {
    const db = await openDb();
    await idbPut(db, { ...session, updatedAt: Date.now() });
    db.close();
  }, []);

  const listSessions = useCallback(async (): Promise<TranscodingSession[]> => {
    const db = await openDb();
    const all = await idbGetAll(db);
    db.close();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, []);

  /** Most recent session that started but didn't finish, if any. */
  const findResumableSession = useCallback(async (): Promise<TranscodingSession | undefined> => {
    const all = await listSessions();
    return all.find((s) => s.lastSegmentIndex >= 0 && s.lastSegmentIndex < s.totalSegments - 1);
  }, [listSessions]);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    const db = await openDb();
    const s = await idbGet(db, id);
    if (s) {
      await idbDelete(db, id);
      db.close();
      try {
        await deleteOpfsFile(s.sourceFilePath);
      } catch {
        // File may already be gone.
      }
    } else {
      db.close();
    }
  }, []);

  return { createSession, updateSession, listSessions, findResumableSession, deleteSession };
}
