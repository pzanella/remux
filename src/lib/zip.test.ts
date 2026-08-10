import { describe, expect, it } from 'vitest';
import { buildZip, parseZip } from './zip';

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('buildZip / parseZip round-trip', () => {
  it('round-trips a single small text entry', async () => {
    const blob = buildZip([{ name: 'hello.txt', data: new TextEncoder().encode('hello world') }]);
    const entries = parseZip(await blobBytes(blob));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('hello.txt');
    expect(new TextDecoder().decode(entries[0].data)).toBe('hello world');
  });

  it('round-trips multiple entries of varying size, including binary data', async () => {
    const binary = new Uint8Array(2000);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256;

    const blob = buildZip([
      { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ a: 1 })) },
      { name: 'source/video.mp4', data: binary },
      { name: 'subtitles/0-en.vtt', data: new TextEncoder().encode('WEBVTT\n\n') },
    ]);
    const entries = parseZip(await blobBytes(blob));
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'source/video.mp4', 'subtitles/0-en.vtt']);
    expect(entries[1].data).toEqual(binary);
  });

  it('round-trips an empty-content entry', async () => {
    const blob = buildZip([{ name: 'empty.txt', data: new Uint8Array(0) }]);
    const entries = parseZip(await blobBytes(blob));
    expect(entries[0].data).toHaveLength(0);
  });

  it('preserves entry names containing forward-slash directory separators', async () => {
    const blob = buildZip([{ name: 'a/b/c.txt', data: new TextEncoder().encode('x') }]);
    const entries = parseZip(await blobBytes(blob));
    expect(entries[0].name).toBe('a/b/c.txt');
  });

  it('throws for data with no end-of-central-directory record', () => {
    expect(() => parseZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/end-of-central-directory/);
  });

  it('refuses to build an empty zip', () => {
    expect(() => buildZip([])).toThrow(/Nothing to zip/);
  });
});
