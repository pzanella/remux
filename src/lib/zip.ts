/**
 * Minimal ZIP writer — STORE only, no compression. HLS segments are already
 * compressed video/audio, so deflating them again would spend CPU for
 * essentially no size reduction; storing them as-is also means each file's
 * bytes only need to be read once, not transformed. Good enough for
 * packaging a flat output folder into one download, not a general-purpose
 * zip library.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** `Uint8Array.buffer` types as `ArrayBufferLike` (it could in principle
 * back onto a `SharedArrayBuffer`), which `BlobPart` doesn't accept — every
 * array here is freshly allocated, never shared, so this is a safe,
 * narrowing cast rather than a real behavior change. */
function toBlobPart(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** ZIP's MS-DOS date/time fields — accuracy doesn't matter here, this just
 * needs to be a valid encoding of *some* timestamp. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** TS's bundled DOM lib doesn't yet type the File System Access API's async
 * iteration (`entries()`/`keys()`/`values()`) — it's a WICG incubation spec,
 * not part of the IDL TS generates its types from. Supported at runtime in
 * every browser this app targets. */
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** Zips every file directly inside `dirHandle` (flat — no subdirectories,
 * matching this app's output layout) into one downloadable Blob. */
export async function createZipBlob(
  dirHandle: FileSystemDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const entries: { name: string; file: File }[] = [];
  for await (const [name, handle] of (dirHandle as IterableDirectoryHandle).entries()) {
    if (handle.kind === 'file') {
      entries.push({ name, file: await (handle as FileSystemFileHandle).getFile() });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    throw new Error('Nothing to download yet.');
  }

  const { time, date } = dosDateTime(new Date());
  const parts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name, file } = entries[i];
    const data = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(data);
    const nameBytes = new TextEncoder().encode(name);

    const localHeader = concatBytes([
      u32(0x04034b50),
      u16(20), // version needed to extract
      u16(0), // general purpose flag
      u16(0), // compression method: stored
      u16(time),
      u16(date),
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    ]);

    parts.push(toBlobPart(localHeader), toBlobPart(data));

    centralParts.push(
      concatBytes([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(0), // general purpose flag
        u16(0), // compression method
        u16(time),
        u16(date),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0), // extra field length
        u16(0), // file comment length
        u16(0), // disk number start
        u16(0), // internal file attributes
        u32(0), // external file attributes
        u32(offset), // relative offset of local header
        nameBytes,
      ]),
    );

    offset += localHeader.length + data.length;
    onProgress?.(i + 1, entries.length);
  }

  for (const c of centralParts) centralSize += c.length;

  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk where central directory starts
    u16(entries.length), // central directory records on this disk
    u16(entries.length), // total central directory records
    u32(centralSize),
    u32(offset), // offset of start of central directory
    u16(0), // comment length
  ]);

  return new Blob([...parts, ...centralParts.map(toBlobPart), toBlobPart(eocd)], { type: 'application/zip' });
}
