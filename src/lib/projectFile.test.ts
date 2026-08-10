import { describe, expect, it } from 'vitest';
import { buildProjectZip, parseProjectZip, type BuildProjectZipParams } from './projectFile';
import { buildZip } from './zip';

function makeVideoFile(name: string, content = 'fake-video-bytes'): File {
  return new File([content], name, { type: 'video/mp4' });
}

function baseParams(overrides: Partial<BuildProjectZipParams> = {}): BuildProjectZipParams {
  return {
    sourceFile: makeVideoFile('vacation.mp4'),
    segments: [{ sourceStart: 0, sourceEnd: 30 }],
    chapters: [],
    subtitleTracks: [],
    subtitleVttTextByFile: {},
    introFile: null,
    outroFile: null,
    dubAudioTracks: [],
    readDubAudioFile: async () => {
      throw new Error('not expected to be called');
    },
    outputContainer: 'ts',
    loudnessNormalization: false,
    abrHeights: [],
    ...overrides,
  };
}

describe('buildProjectZip / parseProjectZip round-trip', () => {
  it('round-trips a minimal project (source only)', async () => {
    const zip = await buildProjectZip(baseParams());
    const parsed = await parseProjectZip(zip);

    expect(parsed.sourceFile.name).toBe('vacation.mp4');
    expect(await parsed.sourceFile.text()).toBe('fake-video-bytes');
    expect(parsed.manifest.segments).toEqual([{ sourceStart: 0, sourceEnd: 30 }]);
    expect(parsed.introFile).toBeNull();
    expect(parsed.outroFile).toBeNull();
    expect(parsed.subtitleFiles).toEqual([]);
    expect(parsed.dubAudioFiles).toEqual([]);
  });

  it('round-trips segments, chapters, and output settings', async () => {
    const zip = await buildProjectZip(
      baseParams({
        segments: [
          { sourceStart: 0, sourceEnd: 5 },
          { sourceStart: 10, sourceEnd: 20 },
        ],
        chapters: [{ time: 0, title: 'Intro' }, { time: 8, title: 'Main' }],
        outputContainer: 'fmp4',
        loudnessNormalization: true,
        abrHeights: [240, 480],
      }),
    );
    const parsed = await parseProjectZip(zip);

    expect(parsed.manifest.segments).toEqual([
      { sourceStart: 0, sourceEnd: 5 },
      { sourceStart: 10, sourceEnd: 20 },
    ]);
    expect(parsed.manifest.chapters).toEqual([{ time: 0, title: 'Intro' }, { time: 8, title: 'Main' }]);
    expect(parsed.manifest.outputContainer).toBe('fmp4');
    expect(parsed.manifest.loudnessNormalization).toBe(true);
    expect(parsed.manifest.abrHeights).toEqual([240, 480]);
  });

  it('round-trips intro/outro clips with their original filenames', async () => {
    const zip = await buildProjectZip(
      baseParams({
        introFile: { file: makeVideoFile('intro-clip.mov', 'intro-bytes') },
        outroFile: { file: makeVideoFile('outro-clip.mov', 'outro-bytes') },
      }),
    );
    const parsed = await parseProjectZip(zip);

    expect(parsed.introFile?.name).toBe('intro-clip.mov');
    expect(await parsed.introFile?.text()).toBe('intro-bytes');
    expect(parsed.outroFile?.name).toBe('outro-clip.mov');
    expect(await parsed.outroFile?.text()).toBe('outro-bytes');
  });

  it('round-trips subtitle tracks using the current (live-edited) VTT text, not a re-read of any original upload', async () => {
    const zip = await buildProjectZip(
      baseParams({
        subtitleTracks: [
          { fileName: 'subs_1.vtt', label: 'English', language: 'en' },
          { fileName: 'subs_2.vtt', label: 'Italian', language: 'it' },
        ],
        // subs_1.vtt has no entry here on purpose, exercising the "no live
        // text yet -> default empty VTT" fallback.
        subtitleVttTextByFile: {
          'subs_2.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCiao\n\n',
        },
      }),
    );
    const parsed = await parseProjectZip(zip);

    expect(parsed.subtitleFiles).toHaveLength(2);
    expect(parsed.subtitleFiles[0]).toMatchObject({ label: 'English', language: 'en' });
    await expect(parsed.subtitleFiles[0].file.text()).resolves.toBe('WEBVTT\n\n');
    expect(parsed.subtitleFiles[1]).toMatchObject({ label: 'Italian', language: 'it' });
    await expect(parsed.subtitleFiles[1].file.text()).resolves.toContain('Ciao');
  });

  it('round-trips dub-audio tracks by reading their bytes through readDubAudioFile', async () => {
    const zip = await buildProjectZip(
      baseParams({
        dubAudioTracks: [{ fileName: 'dub_es.m4a', label: 'Spanish dub', language: 'es' }],
        readDubAudioFile: async (fileName) => {
          expect(fileName).toBe('dub_es.m4a');
          return new File(['spanish-audio-bytes'], 'dub_es.m4a', { type: 'audio/mp4' });
        },
      }),
    );
    const parsed = await parseProjectZip(zip);

    expect(parsed.dubAudioFiles).toHaveLength(1);
    expect(parsed.dubAudioFiles[0]).toMatchObject({ label: 'Spanish dub', language: 'es' });
    await expect(parsed.dubAudioFiles[0].file.text()).resolves.toBe('spanish-audio-bytes');
  });

  it('throws a clear error for a bundle missing manifest.json', async () => {
    const zip = buildZip([{ name: 'source/video.mp4', data: new Uint8Array([1, 2, 3]) }]);
    await expect(parseProjectZip(zip)).rejects.toThrow(/manifest\.json/);
  });

  it('throws a clear error for an incompatible format version', async () => {
    const zip = buildZip([
      {
        name: 'manifest.json',
        data: new TextEncoder().encode(JSON.stringify({ formatVersion: 999, source: { entryName: 'source/x.mp4', fileName: 'x.mp4' } })),
      },
      { name: 'source/x.mp4', data: new Uint8Array([1]) },
    ]);
    await expect(parseProjectZip(zip)).rejects.toThrow(/incompatible/);
  });
});
