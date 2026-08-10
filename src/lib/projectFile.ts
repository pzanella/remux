/**
 * Portable project bundle — a real ZIP (see lib/zip.ts) holding the source
 * video, any intro/outro/dub-audio/subtitle files, and a manifest of every
 * edit (segments, chapters, output settings). This is the "no server, no
 * upload" answer to saving or sharing a project: a downloadable file, not a
 * cloud account. Hand it to a collaborator, or reload it on a different
 * machine, and the editor comes back exactly as it was left.
 *
 * Deliberately not a general-purpose project format: `parseProjectZip` only
 * ever reads a bundle `buildProjectZip` itself produced (see parseZip's own
 * STORE-only limitation), and a version mismatch fails clearly rather than
 * guessing at an unknown shape.
 */
import { buildZip, parseZip, type ZipEntry } from './zip';

export const PROJECT_FILE_EXTENSION = '.remuxproj';
const MANIFEST_ENTRY = 'manifest.json';
const CURRENT_FORMAT_VERSION = 1;

export interface ProjectManifest {
  formatVersion: number;
  source: { entryName: string; fileName: string };
  segments: { sourceStart: number; sourceEnd: number }[];
  chapters: { time: number; title: string }[];
  subtitleTracks: { entryName: string; label: string; language: string }[];
  intro: { entryName: string; fileName: string } | null;
  outro: { entryName: string; fileName: string } | null;
  dubAudioTracks: { entryName: string; label: string; language: string }[];
  outputContainer: 'ts' | 'fmp4';
  loudnessNormalization: boolean;
  abrHeights: number[];
}

export interface BuildProjectZipParams {
  sourceFile: File;
  segments: { sourceStart: number; sourceEnd: number }[];
  chapters: { time: number; title: string }[];
  subtitleTracks: { fileName: string; label: string; language: string }[];
  /** Current (possibly edited) cue text per track's own OPFS filename — the
   * same map `useTranscoder` already keeps for the cue editor, reused here
   * so the bundle captures live edits, not whatever the original upload
   * happened to contain. */
  subtitleVttTextByFile: Record<string, string>;
  introFile: { file: File } | null;
  outroFile: { file: File } | null;
  dubAudioTracks: { fileName: string; label: string; language: string }[];
  /** Dub tracks only keep an OPFS filename in memory (see useTranscoder's
   * own `dubAudioTracks` state) — this reads their real bytes back for
   * zipping. */
  readDubAudioFile: (fileName: string) => Promise<File>;
  outputContainer: 'ts' | 'fmp4';
  loudnessNormalization: boolean;
  abrHeights: number[];
}

export async function buildProjectZip(params: BuildProjectZipParams): Promise<Blob> {
  const entries: ZipEntry[] = [];
  const manifest: ProjectManifest = {
    formatVersion: CURRENT_FORMAT_VERSION,
    source: { entryName: `source/${params.sourceFile.name}`, fileName: params.sourceFile.name },
    segments: params.segments,
    chapters: params.chapters,
    subtitleTracks: [],
    intro: null,
    outro: null,
    dubAudioTracks: [],
    outputContainer: params.outputContainer,
    loudnessNormalization: params.loudnessNormalization,
    abrHeights: params.abrHeights,
  };

  entries.push({ name: manifest.source.entryName, data: new Uint8Array(await params.sourceFile.arrayBuffer()) });

  if (params.introFile) {
    const fileName = params.introFile.file.name;
    const entryName = `intro/${fileName}`;
    manifest.intro = { entryName, fileName };
    entries.push({ name: entryName, data: new Uint8Array(await params.introFile.file.arrayBuffer()) });
  }
  if (params.outroFile) {
    const fileName = params.outroFile.file.name;
    const entryName = `outro/${fileName}`;
    manifest.outro = { entryName, fileName };
    entries.push({ name: entryName, data: new Uint8Array(await params.outroFile.file.arrayBuffer()) });
  }

  for (let i = 0; i < params.subtitleTracks.length; i++) {
    const track = params.subtitleTracks[i];
    const text = params.subtitleVttTextByFile[track.fileName] ?? 'WEBVTT\n\n';
    const entryName = `subtitles/${i}/cues.vtt`;
    manifest.subtitleTracks.push({ entryName, label: track.label, language: track.language });
    entries.push({ name: entryName, data: new TextEncoder().encode(text) });
  }

  for (let i = 0; i < params.dubAudioTracks.length; i++) {
    const track = params.dubAudioTracks[i];
    const file = await params.readDubAudioFile(track.fileName);
    const entryName = `dub-audio/${i}/${file.name}`;
    manifest.dubAudioTracks.push({ entryName, label: track.label, language: track.language });
    entries.push({ name: entryName, data: new Uint8Array(await file.arrayBuffer()) });
  }

  entries.unshift({ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return buildZip(entries);
}

export interface ParsedProject {
  manifest: ProjectManifest;
  sourceFile: File;
  introFile: File | null;
  outroFile: File | null;
  subtitleFiles: { file: File; label: string; language: string }[];
  dubAudioFiles: { file: File; label: string; language: string }[];
}

function entryFileName(entryName: string): string {
  return entryName.slice(entryName.lastIndexOf('/') + 1);
}

function mustFind(entries: ZipEntry[], name: string): ZipEntry {
  const found = entries.find((e) => e.name === name);
  if (!found) throw new Error(`This project file is missing "${name}" — it may be corrupt or from an incompatible version.`);
  return found;
}

export async function parseProjectZip(file: File | Blob): Promise<ParsedProject> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = parseZip(bytes);
  const manifestEntry = mustFind(entries, MANIFEST_ENTRY);
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as ProjectManifest;
  if (manifest.formatVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`This project file was saved by an incompatible version of Remux (format ${manifest.formatVersion}).`);
  }

  // `.slice()` copies into a freshly allocated ArrayBuffer rather than
  // handing out a view into the whole parsed zip buffer — satisfies
  // BlobPart's stricter typing (a Uint8Array subarray's `.buffer` is only
  // typed ArrayBufferLike) and lets the much larger zip buffer be collected
  // independently of these smaller per-file Files.
  const toFile = (entryName: string, fileName: string): File =>
    new File([mustFind(entries, entryName).data.slice()], fileName || entryFileName(entryName));

  return {
    manifest,
    sourceFile: toFile(manifest.source.entryName, manifest.source.fileName),
    introFile: manifest.intro ? toFile(manifest.intro.entryName, manifest.intro.fileName) : null,
    outroFile: manifest.outro ? toFile(manifest.outro.entryName, manifest.outro.fileName) : null,
    subtitleFiles: manifest.subtitleTracks.map((t) => ({
      file: toFile(t.entryName, 'cues.vtt'),
      label: t.label,
      language: t.language,
    })),
    dubAudioFiles: manifest.dubAudioTracks.map((t) => ({
      file: toFile(t.entryName, entryFileName(t.entryName)),
      label: t.label,
      language: t.language,
    })),
  };
}
