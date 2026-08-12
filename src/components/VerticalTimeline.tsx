import { useMemo, useRef, useState } from 'react';
import {
  type EditorSegment,
  PX_PER_SECOND,
  computeCardLayout,
  globalTimeToPixel,
  locateGlobalTime,
  pixelToGlobalTime,
  segmentDuration,
  trimSegmentEnd,
  trimSegmentStart,
} from '../lib/segments';
import { NATIVE_ACCEPT } from './MediaExtrasPanel';

/** A curated warm-orange/teal spread (the two brand colors plus a few
 * in-between tones) rather than a full hue wheel — segment colors need to
 * stay "on brand" while still being visually distinct enough to tell
 * several clips apart at a glance. Picked by a hash of the segment's own
 * `id`, not its position, so a clip keeps its color through drag-reorder —
 * the spine's whole point is a stable "which color = which clip" map. */
const SEGMENT_PALETTE = ['#ff6b4a', '#2fe0a6', '#ff8a68', '#3ff0c0', '#f2795a', '#25c393', '#ffab8f', '#57e6b8'];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h || 1;
}

function colorForSegment(id: string): string {
  return SEGMENT_PALETTE[hashString(id) % SEGMENT_PALETTE.length];
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s.toFixed(1)}s`;
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/** Deterministic placeholder "waveform" — stable per segment id (doesn't
 * jitter on re-render) but not read from real audio. Swap for real
 * per-segment peaks (see lib/mediaPreview.ts's generateWaveformPeaks) once
 * decode is wired up; see the vertical, amplitude-as-width layout note on
 * `.segment-waveform` in index.css for why this can't just reuse the
 * existing horizontal Waveform component as-is. */
function syntheticPeaks(id: string, count: number): number[] {
  let seed = hashString(`${id}_wave`);
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: count }, () => 0.22 + next() * 0.7);
}

interface IntroOutroClip {
  label: string;
  duration?: number;
}

interface IntroOutroSlotProps {
  kind: 'intro' | 'outro';
  clip: IntroOutroClip | null | undefined;
  disabled: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
}

/**
 * A flanking slot above/below the main clip stack, styled like a real clip
 * card (thumb block, name, duration) once something's attached — accepting
 * either a click (opens a picker) or a native OS file drop, the same two
 * ways `EmptyState`'s own dropzone already accepts the very first source
 * file. This is a second entry point alongside MediaExtrasPanel's own
 * "+ Intro"/"+ Outro" buttons, not a replacement for it — dub-audio still
 * only lives there, and this one's whole point is putting intro/outro
 * where they visually belong: in the timeline itself.
 */
function IntroOutroSlot({ kind, clip, disabled, onSelect, onClear }: IntroOutroSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);
  const label = kind === 'intro' ? 'Intro' : 'Outro';

  if (clip) {
    return (
      <div className={`rail-extra-card rail-extra-card--${kind}`}>
        <div className="rail-extra-card-thumb" aria-hidden="true" />
        <div className="rail-extra-card-info">
          <span className="rail-extra-card-tag">{label}</span>
          <span className="rail-extra-card-label">{clip.label}</span>
          {clip.duration !== undefined && <span className="rail-extra-card-duration">{formatDuration(clip.duration)}</span>}
        </div>
        <button type="button" className="rail-extra-card-remove" onClick={onClear} title={`Remove ${label.toLowerCase()}`}>
          ✕
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`rail-extra-slot${isOver ? ' is-drag-over' : ''}`}
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        if (disabled) return;
        const file = e.dataTransfer.files?.[0];
        if (file) onSelect(file);
      }}
      title={disabled ? 'Not available together with a trimmed/split timeline yet' : `Drop a video here, or click to add ${kind === 'intro' ? 'an intro' : 'an outro'}`}
    >
      <span className="rail-extra-slot-plus">+</span> {label}
      <input
        ref={inputRef}
        type="file"
        accept={NATIVE_ACCEPT}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.target.value = '';
        }}
      />
    </button>
  );
}

interface VerticalTimelineProps {
  segments: EditorSegment[];
  selectedId: string | null;
  playheadTime: number;
  sourceDuration: number;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelect: (id: string) => void;
  onPlayheadChange: (time: number) => void;
  onSplit: () => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  beginGesture: () => void;
  previewUpdate: (mutate: (prev: EditorSegment[]) => EditorSegment[]) => void;
  commitGesture: () => void;
  /** Attached intro/outro clips — shown as flanking cards above/below the
   * main clip stack, styled like a real clip, so they're part of what the
   * timeline visibly shows rather than only living in the separate
   * collapsed extras strip (see MediaExtrasPanel). Not part of
   * `segments`/the pixel-precise card layout at all: intro/outro splicing
   * is mutually exclusive with a trimmed/split timeline (see
   * `hasIntroOrOutro` below), so there's never a case where these coexist
   * with more than the one trivial segment. */
  introClip?: IntroOutroClip | null;
  outroClip?: IntroOutroClip | null;
  onSelectIntroFile: (file: File) => void;
  onClearIntroFile: () => void;
  onSelectOutroFile: (file: File) => void;
  onClearOutroFile: () => void;
  /** Disables Split (and the empty intro/outro slots' own picker/drop) —
   * intro/outro splicing and a trimmed/split timeline aren't supported
   * together yet (see remux.worker.ts's own guard). `hasIntroOrOutro`
   * blocks Split once intro/outro is attached; `hasEditedSegments` (the
   * other half of the same guard, mirrored in MediaExtrasPanel) blocks
   * attaching intro/outro once segments are edited — whichever happens
   * first blocks the other, instead of only failing at export time. */
  hasIntroOrOutro: boolean;
  hasEditedSegments: boolean;
}

/**
 * The vertical timeline rail: a stack of cards, one per segment, height
 * proportional to trimmed duration. Everything here is driven off
 * `computeCardLayout`'s pixel geometry (segments.ts) so the spine, the
 * playhead line, and click-to-scrub all agree on where a given card
 * actually is, even once the height floor kicks in for short clips.
 */
export default function VerticalTimeline({
  segments,
  selectedId,
  playheadTime,
  sourceDuration,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSelect,
  onPlayheadChange,
  onSplit,
  onDelete,
  onReorder,
  beginGesture,
  previewUpdate,
  commitGesture,
  introClip,
  outroClip,
  onSelectIntroFile,
  onClearIntroFile,
  onSelectOutroFile,
  onClearOutroFile,
  hasIntroOrOutro,
  hasEditedSegments,
}: VerticalTimelineProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const layout = useMemo(() => computeCardLayout(segments), [segments]);
  const totalHeight = layout.length > 0 ? layout[layout.length - 1].top + layout[layout.length - 1].height : 0;
  const playheadPx = useMemo(() => globalTimeToPixel(segments, layout, playheadTime), [segments, layout, playheadTime]);
  const playheadLocation = useMemo(() => locateGlobalTime(segments, playheadTime), [segments, playheadTime]);

  const scrubAt = (clientY: number) => {
    const el = railRef.current;
    if (!el || segments.length === 0) return;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    onPlayheadChange(pixelToGlobalTime(segments, layout, y));
  };

  const handleRailPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Clicking a card both selects it (its own onClick) and scrubs the
    // playhead to that Y position — only the small interactive controls
    // inside a card (trim handles, split button, delete, drag handle) opt
    // out of also being treated as a rail click.
    if ((e.target as HTMLElement).closest('.trim-handle, .split-button, .segment-card-delete, .drag-handle')) return;
    scrubAt(e.clientY);
  };

  const handleDragStart = (index: number) => (e: React.DragEvent) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) setDragOverIndex(index);
  };
  const handleDrop = (index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverIndex(null);
    if (from === null || from === index) return;
    onReorder(from, index);
  };
  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  return (
    <div className="timeline-rail-panel">
      <div className="rail-toolbar">
        <span className="section-label">Timeline</span>
        <div className="rail-toolbar-actions">
          <button type="button" className="btn-quiet" onClick={onUndo} disabled={disabled || !canUndo} title="Undo (Ctrl/Cmd+Z)">
            Undo
          </button>
          <button type="button" className="btn-quiet" onClick={onRedo} disabled={disabled || !canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">
            Redo
          </button>
        </div>
      </div>
      <IntroOutroSlot kind="intro" clip={introClip} disabled={hasEditedSegments} onSelect={onSelectIntroFile} onClear={onClearIntroFile} />
      <div className="timeline-rail" ref={railRef} onPointerDown={handleRailPointerDown} style={{ minHeight: totalHeight }}>
      <div className="rail-spine">
        {layout.map((card, i) => (
          <div key={card.id} className="rail-spine-segment" style={{ top: card.top, height: card.height, background: colorForSegment(segments[i].id) }} />
        ))}
      </div>

      <div className="rail-cards">
        {segments.map((seg, i) => {
          const card = layout[i];
          const selected = seg.id === selectedId;
          const color = colorForSegment(seg.id);
          const duration = segmentDuration(seg);
          const peaks = syntheticPeaks(seg.id, Math.max(6, Math.min(48, Math.round(card.height / 6))));
          const splitVisible = selected && playheadLocation?.index === i;
          // Kept clear of both the top trim handle and the bottom info bar
          // (where the delete button lives) so the floating button never
          // visually collides with either, even when the playhead sits
          // right at a card's edge.
          const splitLocalPx = splitVisible
            ? Math.min(
                Math.max(((playheadLocation!.localSourceTime - seg.sourceStart) / Math.max(0.001, duration)) * card.height, 18),
                card.height - 42,
              )
            : 0;

          return (
            <div
              key={seg.id}
              className={`segment-card${selected ? ' is-selected' : ''}${dragOverIndex === i ? ' is-drag-over' : ''}`}
              style={{ height: card.height }}
              draggable={!disabled}
              onDragStart={handleDragStart(i)}
              onDragOver={handleDragOver(i)}
              onDrop={handleDrop(i)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelect(seg.id)}
            >
              <div
                className="segment-card-thumb"
                style={{
                  background: `linear-gradient(160deg, color-mix(in srgb, ${color} 55%, var(--bg-sunken)) 0%, color-mix(in srgb, ${color} 14%, var(--bg-sunken)) 100%)`,
                }}
              >
                <div className="segment-waveform">
                  {peaks.map((p, pi) => (
                    <span key={pi} className="segment-waveform-bar" style={{ width: `${p * 100}%`, background: color }} />
                  ))}
                </div>
              </div>

              <div className="segment-card-info">
                <span className="drag-handle" draggable={false} title="Drag to reorder">
                  ⠿
                </span>
                <span className="segment-card-name">Clip {i + 1}</span>
                <span className="segment-card-duration">{formatDuration(duration)}</span>
                <button
                  type="button"
                  className="segment-card-delete"
                  draggable={false}
                  disabled={disabled || segments.length <= 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(seg.id);
                  }}
                  title={segments.length <= 1 ? 'At least one clip must remain' : 'Delete this clip'}
                >
                  ✕
                </button>
              </div>

              {selected && (
                <>
                  <TrimHandle
                    edge="start"
                    segment={seg}
                    sourceDuration={sourceDuration}
                    disabled={disabled}
                    beginGesture={beginGesture}
                    previewUpdate={previewUpdate}
                    commitGesture={commitGesture}
                  />
                  <TrimHandle
                    edge="end"
                    segment={seg}
                    sourceDuration={sourceDuration}
                    disabled={disabled}
                    beginGesture={beginGesture}
                    previewUpdate={previewUpdate}
                    commitGesture={commitGesture}
                  />
                </>
              )}

              {splitVisible && (
                <button
                  type="button"
                  className="split-button"
                  draggable={false}
                  style={{ top: splitLocalPx }}
                  disabled={disabled || hasIntroOrOutro}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSplit();
                  }}
                  title={hasIntroOrOutro ? 'Not available together with an attached intro/outro yet — remove it first' : 'Split this clip at the playhead'}
                >
                  ✂ Split here
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="rail-playhead" style={{ top: playheadPx }}>
        <span className="rail-playhead-badge">{formatDuration(playheadTime)}</span>
      </div>
      </div>
      <IntroOutroSlot kind="outro" clip={outroClip} disabled={hasEditedSegments} onSelect={onSelectOutroFile} onClear={onClearOutroFile} />
    </div>
  );
}

interface TrimHandleProps {
  edge: 'start' | 'end';
  segment: EditorSegment;
  sourceDuration: number;
  disabled: boolean;
  beginGesture: () => void;
  previewUpdate: (mutate: (prev: EditorSegment[]) => EditorSegment[]) => void;
  commitGesture: () => void;
}

function TrimHandle({ edge, segment, sourceDuration, disabled, beginGesture, previewUpdate, commitGesture }: TrimHandleProps) {
  const dragStartRef = useRef<{ y: number; value: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { y: e.clientY, value: edge === 'start' ? segment.sourceStart : segment.sourceEnd };
    beginGesture();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const deltaSec = (e.clientY - start.y) / PX_PER_SECOND;
    const candidate = start.value + deltaSec;
    if (edge === 'start') {
      previewUpdate((prev) => trimSegmentStart(prev, segment.id, candidate));
    } else {
      previewUpdate((prev) => trimSegmentEnd(prev, segment.id, candidate, sourceDuration));
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    commitGesture();
  };

  return (
    <div
      className={`trim-handle trim-handle--${edge}`}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
