import { useEffect, useRef, useState } from 'react';
import { parseCues } from '../lib/vtt';
import { generateThumbnails, generateWaveformPeaks } from '../lib/mediaPreview';
import type { ClipFile } from '../hooks/useTranscoder';
import SubtitleCueEditor from './SubtitleCueEditor';
import Waveform from './Waveform';

const NATIVE_ACCEPT = '.mp4,.mov,.m4v,.3gp,.f4v';
const MAIN_ACCEPT =
  'video/mp4,video/quicktime,video/x-matroska,video/webm,video/avi,video/x-msvideo,video/x-flv,video/x-ms-wmv,video/mpeg,video/ogg,.mp4,.mov,.m4v,.mkv,.webm,.avi,.wmv,.flv,.ts,.mts,.m2ts,.ogv,.mpg,.mpeg,.3gp,.f4v';
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 90, 120, 300, 600];
const THUMB_COUNT = 10;
const PEAK_COUNT = 200;
/** Width reserved for an empty "+ Intro"/"+ Outro" add-slot button, sitting
 * outside the time-scaled area so it never distorts the intro/main/outro
 * proportions — see the comment on `.timeline-scaled-area` in index.css. */
const ADD_SLOT_REM = 5;

function pickTickInterval(totalSeconds: number, targetTicks = 9): number {
  if (totalSeconds <= 0) return 1;
  const raw = totalSeconds / targetTicks;
  return TICK_STEPS.find((s) => s >= raw) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

function formatTick(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '…';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Generates and caches thumbnails + waveform peaks for one clip file,
 * re-running whenever the file itself changes. */
function useMediaPreview(file: File | null) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);

  useEffect(() => {
    setThumbnails([]);
    setPeaks([]);
    if (!file) return;

    let cancelled = false;
    void generateThumbnails(file, THUMB_COUNT).then((t) => {
      if (!cancelled) setThumbnails(t);
    });
    void generateWaveformPeaks(file, PEAK_COUNT).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  return { thumbnails, peaks };
}

/** Drag-and-drop-from-Finder/Explorer support for one drop target — every
 * file picker on the timeline (empty or already filled) doubles as one, so
 * dropping a new file works the same as clicking and choosing it. */
function useFileDrop(onFile: (f: File) => void, disabled: boolean) {
  const [isOver, setIsOver] = useState(false);

  const onDragOver = (e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsOver(true);
  };
  const onDragLeave = () => setIsOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return { isOver, onDragOver, onDragLeave, onDrop };
}

function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 7.5v5h3l4.5 3.5v-12L5 7.5H2z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M13 7.5l4.5 5M17.5 7.5L13 12.5" />
      ) : (
        <>
          <path d="M12.5 7.2a4 4 0 010 5.6" />
          <path d="M14.8 5a7.5 7.5 0 010 10" />
        </>
      )}
    </svg>
  );
}

function IconWarning() {
  return (
    <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2.5l8.5 14.5H1.5L10 2.5z" />
      <line x1="10" y1="7.7" x2="10" y2="11.5" />
      <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export type ClipKind = 'intro' | 'main' | 'outro';

interface TimelineProps {
  disabled: boolean;
  sourceFile: File | null;
  sourceLabel: string | null;
  sourceDuration: number | undefined;
  introFile: ClipFile | null;
  outroFile: ClipFile | null;
  subtitleTrack: { fileName: string; label: string; language: string } | null;
  subtitleVttText: string;
  selectedClip: ClipKind | null;
  playheadTime: number;
  muted: boolean;
  onToggleMute: () => void;
  onSelectClip: (clip: ClipKind) => void;
  onScrub: (clip: ClipKind, localTime: number) => void;
  onSelectMainFile: (file: File) => void;
  onSelectIntro: (file: File) => void;
  onClearIntro: () => void;
  onSelectOutro: (file: File) => void;
  onClearOutro: () => void;
  onSelectSubtitle: (file: File) => void;
  onClearSubtitle: () => void;
  onSaveSubtitleEdits: (vtt: string) => void;
  onSubtitleLanguageChange: (lang: string) => void;
}

export default function Timeline({
  disabled,
  sourceFile,
  sourceLabel,
  sourceDuration,
  introFile,
  outroFile,
  subtitleTrack,
  subtitleVttText,
  selectedClip,
  playheadTime,
  muted,
  onToggleMute,
  onSelectClip,
  onScrub,
  onSelectMainFile,
  onSelectIntro,
  onClearIntro,
  onSelectOutro,
  onClearOutro,
  onSelectSubtitle,
  onClearSubtitle,
  onSaveSubtitleEdits,
  onSubtitleLanguageChange,
}: TimelineProps) {
  const [cueEditorOpen, setCueEditorOpen] = useState(false);
  const mainInputRef = useRef<HTMLInputElement>(null);
  const introInputRef = useRef<HTMLInputElement>(null);
  const outroInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const scaledAreaRef = useRef<HTMLDivElement>(null);

  const introMedia = useMediaPreview(introFile?.file ?? null);
  const mainMedia = useMediaPreview(sourceFile);
  const outroMedia = useMediaPreview(outroFile?.file ?? null);

  const hasIntro = !!introFile;
  const hasOutro = !!outroFile;

  const introDur = introFile?.duration ?? 0;
  const mainDur = sourceDuration ?? 0;
  const outroDur = outroFile?.duration ?? 0;
  // Every row (ruler, video, audio, subtitles) sizes its content off this
  // exact same total — that shared scale is what keeps them all lined up
  // vertically. It intentionally excludes any "add a clip" affordance
  // width, which lives outside the scaled area entirely (see
  // `.timeline-scaled-area` in index.css) instead of distorting it.
  const totalDur = introDur + mainDur + outroDur;
  const introPct = totalDur > 0 ? (introDur / totalDur) * 100 : 0;
  const mainPct = totalDur > 0 ? (mainDur / totalDur) * 100 : 0;
  const outroPct = totalDur > 0 ? (outroDur / totalDur) * 100 : 0;

  const interval = pickTickInterval(totalDur);
  const ticks: number[] = [];
  for (let t = 0; totalDur > 0 && t <= totalDur; t += interval) ticks.push(t);

  const cues = subtitleVttText ? parseCues(subtitleVttText) : [];
  const playheadPercent = totalDur > 0 ? Math.min(100, (playheadTime / totalDur) * 100) : 0;
  // Cues are authored against the main content's own length — if they run
  // past the end of everything (a track meant for a longer/different cut,
  // or an edit that pushed a cue too far), clamp what's drawn rather than
  // let it visually spill out of the timeline, and flag it so it's obvious
  // something needs trimming instead of failing silently.
  const hasSubtitleOverflow = totalDur > 0 && cues.some((c) => introDur + c.end > totalDur + 0.05);

  const mainDrop = useFileDrop(onSelectMainFile, disabled);
  const introDrop = useFileDrop(onSelectIntro, disabled);
  const outroDrop = useFileDrop(onSelectOutro, disabled);
  const subtitleDrop = useFileDrop(onSelectSubtitle, disabled);

  const scrubAt = (clientX: number) => {
    const el = scaledAreaRef.current;
    if (!el || totalDur <= 0) return;
    const rect = el.getBoundingClientRect();
    const percent = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const globalTime = percent * totalDur;
    if (globalTime < introDur) onScrub('intro', globalTime);
    else if (globalTime < introDur + mainDur) onScrub('main', globalTime - introDur);
    else onScrub('outro', globalTime - introDur - mainDur);
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (totalDur <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  };
  const handleRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    scrubAt(e.clientX);
  };

  const handlePick = (onFile: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = '';
  };

  return (
    <div className="timeline">
      <span className="section-label">Timeline</span>

      {!sourceLabel ? (
        <button
          type="button"
          className={`timeline-clip timeline-clip--empty timeline-clip--main-empty${mainDrop.isOver ? ' is-drag-over' : ''}`}
          onClick={() => mainInputRef.current?.click()}
          onDragOver={mainDrop.onDragOver}
          onDragLeave={mainDrop.onDragLeave}
          onDrop={mainDrop.onDrop}
        >
          <span>Choose a video…</span>
          <span className="panel-hint">MP4, MOV, MKV, WebM and more — or drop a file</span>
        </button>
      ) : (
        <div
          className="timeline-tracks"
          style={{ '--intro-slot': hasIntro ? '0rem' : `${ADD_SLOT_REM}rem`, '--outro-slot': hasOutro ? '0rem' : `${ADD_SLOT_REM}rem` } as React.CSSProperties}
        >
          <div className="timeline-labels">
            <div className="timeline-label-cell timeline-label-cell--ruler" />
            <div className="timeline-label-cell">Video</div>
            <div className="timeline-label-cell">
              <button type="button" className="timeline-mute-btn" onClick={onToggleMute} title={muted ? 'Unmute preview' : 'Mute preview'}>
                <IconSpeaker muted={muted} />
              </button>
              Audio
            </div>
            <div className="timeline-label-cell">
              Subtitles
              {hasSubtitleOverflow && (
                <span className="timeline-warning" title="Some subtitles extend past the end of the video and will be cut off">
                  <IconWarning />
                </span>
              )}
            </div>
          </div>

          <div className="timeline-add-slot timeline-add-slot--intro">
            {!hasIntro && (
              <button
                type="button"
                className={`timeline-add-btn${introDrop.isOver ? ' is-drag-over' : ''}`}
                onClick={() => introInputRef.current?.click()}
                onDragOver={introDrop.onDragOver}
                onDragLeave={introDrop.onDragLeave}
                onDrop={introDrop.onDrop}
                disabled={disabled}
              >
                + Intro
              </button>
            )}
          </div>

          <div className="timeline-scaled-area" ref={scaledAreaRef}>
            <div className="timeline-ruler" onPointerDown={handleRulerPointerDown} onPointerMove={handleRulerPointerMove}>
              {ticks.map((t) => (
                <span key={t} className="timeline-tick" style={{ left: `${(t / totalDur) * 100}%` }}>
                  {formatTick(t)}
                </span>
              ))}
            </div>

            <div className="timeline-track timeline-track--video">
              {hasIntro && (
                <ClipCell
                  kind="intro"
                  file={introFile}
                  media={introMedia}
                  widthPercent={introPct}
                  selected={selectedClip === 'intro'}
                  disabled={disabled}
                  onSelect={() => onSelectClip('intro')}
                  onClear={onClearIntro}
                  onDropFile={onSelectIntro}
                />
              )}
              <ClipCell
                kind="main"
                file={{ label: sourceLabel, duration: sourceDuration }}
                media={mainMedia}
                widthPercent={mainPct}
                selected={selectedClip === 'main'}
                disabled={disabled}
                onSelect={() => onSelectClip('main')}
                onClear={null}
                onDropFile={onSelectMainFile}
              />
              {hasOutro && (
                <ClipCell
                  kind="outro"
                  file={outroFile}
                  media={outroMedia}
                  widthPercent={outroPct}
                  selected={selectedClip === 'outro'}
                  disabled={disabled}
                  onSelect={() => onSelectClip('outro')}
                  onClear={onClearOutro}
                  onDropFile={onSelectOutro}
                />
              )}
            </div>

            <div className="timeline-track timeline-track--audio">
              {hasIntro && <AudioCell widthPercent={introPct} peaks={introMedia.peaks} muted={muted} />}
              <AudioCell widthPercent={mainPct} peaks={mainMedia.peaks} muted={muted} />
              {hasOutro && <AudioCell widthPercent={outroPct} peaks={outroMedia.peaks} muted={muted} />}
            </div>

            <div
              className={`timeline-subtitle-track${subtitleDrop.isOver ? ' is-drag-over' : ''}`}
              onDoubleClick={() => setCueEditorOpen(true)}
              onDragOver={subtitleDrop.onDragOver}
              onDragLeave={subtitleDrop.onDragLeave}
              onDrop={subtitleDrop.onDrop}
              title="Double-click to edit subtitles"
            >
              <span className="timeline-subtitle-label">
                {subtitleTrack ? `${subtitleTrack.label} (${subtitleTrack.language})` : 'Subtitles'}
              </span>
              {cues.map((cue) => {
                // Clamp to the container instead of letting an out-of-range
                // cue visually spill past the timeline's right edge — the
                // warning icon in the track label is what actually flags
                // the problem; this just keeps it from looking broken. The
                // left edge is capped a bit short of 100% too, so the
                // minimum-width floor below can never push the box past
                // the edge it was just clamped to.
                const MIN_WIDTH_PERCENT = 0.4;
                const leftPercent = Math.min(100 - MIN_WIDTH_PERCENT, ((introDur + cue.start) / totalDur) * 100);
                const rightPercent = Math.min(100, ((introDur + cue.end) / totalDur) * 100);
                const widthPercent = Math.max(MIN_WIDTH_PERCENT, rightPercent - leftPercent);
                return <span key={cue.id} className="timeline-cue" style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }} />;
              })}
              {!subtitleTrack && cues.length === 0 && (
                <button
                  type="button"
                  className="timeline-subtitle-add"
                  onClick={(e) => {
                    e.stopPropagation();
                    subtitleInputRef.current?.click();
                  }}
                  disabled={disabled}
                  title="Add a .srt/.vtt file, or double-click the track to write subtitles yourself"
                >
                  + Add subtitles
                </button>
              )}
              {subtitleTrack && (
                <span
                  className="timeline-clip-remove timeline-subtitle-remove"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearSubtitle();
                  }}
                >
                  ✕
                </span>
              )}
            </div>

            <div className="timeline-playhead" style={{ left: `${playheadPercent}%` }} />
          </div>

          <div className="timeline-add-slot timeline-add-slot--outro">
            {!hasOutro && (
              <button
                type="button"
                className={`timeline-add-btn${outroDrop.isOver ? ' is-drag-over' : ''}`}
                onClick={() => outroInputRef.current?.click()}
                onDragOver={outroDrop.onDragOver}
                onDragLeave={outroDrop.onDragLeave}
                onDrop={outroDrop.onDrop}
                disabled={disabled}
              >
                + Outro
              </button>
            )}
          </div>
        </div>
      )}

      <input ref={mainInputRef} type="file" accept={MAIN_ACCEPT} className="sr-only" onChange={handlePick(onSelectMainFile)} />
      <input ref={introInputRef} type="file" accept={NATIVE_ACCEPT} className="sr-only" onChange={handlePick(onSelectIntro)} />
      <input ref={outroInputRef} type="file" accept={NATIVE_ACCEPT} className="sr-only" onChange={handlePick(onSelectOutro)} />
      <input ref={subtitleInputRef} type="file" accept=".srt,.vtt" className="sr-only" onChange={handlePick(onSelectSubtitle)} />

      {cueEditorOpen && (
        <SubtitleCueEditor
          vttText={subtitleVttText}
          language={subtitleTrack?.language ?? 'en'}
          onLanguageChange={onSubtitleLanguageChange}
          onSave={(vtt) => {
            onSaveSubtitleEdits(vtt);
            setCueEditorOpen(false);
          }}
          onClose={() => setCueEditorOpen(false)}
        />
      )}
    </div>
  );
}

interface ClipCellProps {
  kind: ClipKind;
  file: { label: string; duration?: number } | null;
  media: { thumbnails: string[]; peaks: number[] };
  widthPercent: number;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onClear: (() => void) | null;
  onDropFile: (file: File) => void;
}

function ClipCell({ kind, file, media, widthPercent, selected, disabled, onSelect, onClear, onDropFile }: ClipCellProps) {
  const drop = useFileDrop(onDropFile, disabled);
  if (!file) return null;

  return (
    <button
      type="button"
      className={`timeline-clip timeline-clip--${kind}${selected ? ' is-selected' : ''}${drop.isOver ? ' is-drag-over' : ''}`}
      style={{ width: `${widthPercent}%` }}
      onClick={onSelect}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      disabled={disabled}
    >
      <div className="timeline-clip-thumbs">
        {media.thumbnails.map((src, i) => (
          <img key={i} src={src} alt="" draggable={false} />
        ))}
      </div>
      <div className="timeline-clip-info">
        <span className="timeline-clip-label">{kind === 'main' ? file.label : kind === 'intro' ? 'Intro' : 'Outro'}</span>
        <span className="timeline-clip-duration">{formatDuration(file.duration)}</span>
      </div>
      {onClear && (
        <span
          className="timeline-clip-remove"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          ✕
        </span>
      )}
    </button>
  );
}

function AudioCell({ widthPercent, peaks, muted }: { widthPercent: number; peaks: number[]; muted: boolean }) {
  return (
    <div className="timeline-clip timeline-clip--audio" style={{ width: `${widthPercent}%` }}>
      <Waveform peaks={peaks} colorVar={muted ? '--text-muted' : '--accent'} />
    </div>
  );
}
