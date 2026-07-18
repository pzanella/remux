/**
 * FileSystemSyncAccessHandle only exists in lib.webworker.d.ts. The app's
 * tsconfig uses the DOM lib (not webworker), so it's declared here instead.
 */

interface FileSystemReadWriteOptions {
  at?: number;
}

interface FileSystemSyncAccessHandle {
  truncate(newSize: number): void;
  getSize(): number;
  write(buffer: ArrayBuffer | ArrayBufferView, options?: FileSystemReadWriteOptions): number;
  read(buffer: ArrayBuffer | ArrayBufferView, options?: FileSystemReadWriteOptions): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
