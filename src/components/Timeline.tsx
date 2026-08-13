import { useRef, useState } from 'react';
import { type EditorSegment, flattenedDuration, segmentDuration, segmentOffsets, trimSegmentEnd, trimSegmentStart } from '../lib/segments';
import { NATIVE_ACCEPT } from './MediaExtrasPanel';

/** A curated warm-orange/teal spread (the two brand colors plus a few
 * in-between tones) rather than a full hue wheel — clip colors need to stay
 * "on brand" while still being visually distinct enough to tell several
 * clips apart at a glance. Picked by a hash of the segment's own `id`, not
 * its position, so a clip keeps its color through drag-reorder. */
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
 * decode is wired up. */
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
  isImage?: boolean;
}

interface IntroOutroSlotProps {
  kind: 'intro' | 'outro';
  clip: IntroOutroClip | null | undefined;
  disabled: boolean;
  onSelect: (file: File) => void;
  onClear: () => void;
  onSetHoldDuration: (seconds: number) => void;
}

/**
 * A fixed-width slot flanking the clips track — to the left for intro, the
 * right for outro, matching where they actually sit in the final spliced
 * output. Once something's attached, rendered with the exact same
 * `.timeline-clip-*` markup a real content clip uses (color-coded waveform
 * thumb, name, duration, delete button) via the `.timeline-clip--extra`
 * modifier (see index.css) — a fixed-width flex child instead of a
 * proportionally-positioned one, since intro/outro have no shared timeline
 * axis with the content track, but visually indistinguishable otherwise.
 * The empty state accepts either a click (opens a picker) or a native OS
 * file drop, the same two ways `EmptyState`'s own dropzone already accepts
 * the very first source file.
 */
function IntroOutroSlot({ kind, clip, disabled, onSelect, onClear, onSetHoldDuration }: IntroOutroSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);
  const label = kind === 'intro' ? 'Intro' : 'Outro';
  // Fixed per kind rather than colorForSegment's per-id hash — intro/outro
  // aren't drawn from `segments`, and a stable intro=teal/outro=accent
  // pairing is worth keeping regardless of which file is attached.
  const color = kind === 'intro' ? 'var(--teal)' : 'var(--accent)';

  if (clip) {
    const peaks = syntheticPeaks(kind, 14);
    return (
      <div className={`timeline-clip timeline-clip--extra timeline-clip--${kind}`} title={clip.label}>
        <div
          className="timeline-clip-thumb"
          style={{
            background: `linear-gradient(200deg, color-mix(in srgb, ${color} 55%, var(--bg-sunken)) 0%, color-mix(in srgb, ${color} 14%, var(--bg-sunken)) 100%)`,
          }}
        >
          <div className="timeline-clip-waveform">
            {peaks.map((p, pi) => (
              <span key={pi} className="timeline-clip-waveform-bar" style={{ height: `${p * 100}%`, background: color }} />
            ))}
          </div>
        </div>

        <div className="timeline-clip-info">
          <span className="timeline-clip-name">{label}</span>
          {clip.isImage ? (
            <label className="timeline-clip-hold" onClick={(e) => e.stopPropagation()}>
              Hold
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={clip.duration ?? 3}
                onChange={(e) => {
                  const seconds = parseFloat(e.target.value);
                  if (!Number.isNaN(seconds)) onSetHoldDuration(seconds);
                }}
              />
              s
            </label>
          ) : (
            clip.duration !== undefined && <span className="timeline-clip-duration">{formatDuration(clip.duration)}</span>
          )}
          <button
            type="button"
            className="timeline-clip-delete"
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title={`Remove ${label.toLowerCase()}`}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`timeline-extra-slot${isOver ? ' is-drag-over' : ''}`}
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
      title={
        disabled
          ? 'Not available together with a trimmed/split timeline yet'
          : `Drop a video or image here, or click to add ${kind === 'intro' ? 'an intro' : 'an outro'}`
      }
    >
      <span className="timeline-extra-slot-plus">+</span> {label}
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

interface TimelineProps {
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
  /** Attached intro/outro clips — shown as flanking cards to the left/right
   * of the main clip track, styled like a real clip, so they're part of
   * what the timeline visibly shows rather than only living in a separate
   * panel. Not part of `segments`'s own proportional layout at all:
   * intro/outro splicing is mutually exclusive with a trimmed/split
   * timeline (see `hasIntroOrOutro` below), so there's never a case where
   * these coexist with more than the one trivial segment. */
  introClip?: IntroOutroClip | null;
  outroClip?: IntroOutroClip | null;
  onSelectIntroFile: (file: File) => void;
  onClearIntroFile: () => void;
  onSetIntroImageDuration: (seconds: number) => void;
  onSelectOutroFile: (file: File) => void;
  onClearOutroFile: () => void;
  onSetOutroImageDuration: (seconds: number) => void;
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
 * The horizontal timeline: a single track of clip blocks positioned as a
 * `%` of the flattened (post-edit) total duration — the same proportional
 * model `CaptionLane`/`ChapterRuler` already use for their own lanes under
 * the preview, chosen deliberately over a fixed pixels-per-second + scroll
 * model for simplicity (no zoom/scroll machinery needed). Intro/outro flank
 * the track as fixed-width slots, left and right, matching where they
 * actually land in the final spliced output.
 */
export default function Timeline({
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
  onSetIntroImageDuration,
  onSelectOutroFile,
  onClearOutroFile,
  onSetOutroImageDuration,
  hasIntroOrOutro,
  hasEditedSegments,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const totalDuration = flattenedDuration(segments);
  const offsets = segmentOffsets(segments);
  const playheadPercent = totalDuration > 0 ? (playheadTime / totalDuration) * 100 : 0;

  const scrubAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el || totalDuration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onPlayheadChange(fraction * totalDuration);
  };

  // Seconds-per-pixel is recomputed from the track's own current width right
  // as a trim gesture begins (not a fixed constant, since there's no more
  // fixed px/sec scale) — passed down to TrimHandle so its pointer-move math
  // doesn't need to re-measure the DOM on every frame.
  const getSecondsPerPixel = (): number => {
    const el = trackRef.current;
    if (!el || totalDuration <= 0) return 0;
    const width = el.getBoundingClientRect().width;
    return width > 0 ? totalDuration / width : 0;
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Clicking a clip both selects it (its own onClick) and scrubs the
    // playhead to that X position — only the small interactive controls
    // inside a clip (trim handles, split button, delete, drag handle) opt
    // out of also being treated as a track click.
    if ((e.target as HTMLElement).closest('.trim-handle, .split-button, .timeline-clip-delete, .drag-handle')) return;
    scrubAt(e.clientX);
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
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <span className="section-label">Timeline</span>
        <div className="timeline-toolbar-actions">
          <button type="button" className="btn-quiet" onClick={onUndo} disabled={disabled || !canUndo} title="Undo (Ctrl/Cmd+Z)">
            Undo
          </button>
          <button type="button" className="btn-quiet" onClick={onRedo} disabled={disabled || !canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">
            Redo
          </button>
        </div>
      </div>
      {hasEditedSegments && (
        <span className="timeline-warning">Intro/outro isn't available together with a trimmed/split timeline yet — undo those edits first.</span>
      )}

      <div className="timeline-strip">
        <IntroOutroSlot
          kind="intro"
          clip={introClip}
          disabled={hasEditedSegments}
          onSelect={onSelectIntroFile}
          onClear={onClearIntroFile}
          onSetHoldDuration={onSetIntroImageDuration}
        />

        <div className="timeline-track" ref={trackRef} onPointerDown={handleTrackPointerDown}>
          {segments.map((seg, i) => {
            const selected = seg.id === selectedId;
            const color = colorForSegment(seg.id);
            const duration = segmentDuration(seg);
            const leftPercent = totalDuration > 0 ? (offsets[i] / totalDuration) * 100 : 0;
            const widthPercent = totalDuration > 0 ? (duration / totalDuration) * 100 : 100;
            const peaks = syntheticPeaks(seg.id, 24);
            const splitVisible = selected && playheadTime >= offsets[i] && playheadTime <= offsets[i] + duration;
            // Kept clear of the clip's own left/right edges (where the trim
            // handles live) so the floating button never visually collides
            // with either, even when the playhead sits right at a clip's edge.
            const splitLocalPercent = splitVisible
              ? Math.min(Math.max(((playheadTime - offsets[i]) / Math.max(0.001, duration)) * 100, 8), 92)
              : 0;

            return (
              <div
                key={seg.id}
                className={`timeline-clip${selected ? ' is-selected' : ''}${dragOverIndex === i ? ' is-drag-over' : ''}`}
                style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                draggable={!disabled}
                onDragStart={handleDragStart(i)}
                onDragOver={handleDragOver(i)}
                onDrop={handleDrop(i)}
                onDragEnd={handleDragEnd}
                onClick={() => onSelect(seg.id)}
              >
                <div
                  className="timeline-clip-thumb"
                  style={{
                    background: `linear-gradient(200deg, color-mix(in srgb, ${color} 55%, var(--bg-sunken)) 0%, color-mix(in srgb, ${color} 14%, var(--bg-sunken)) 100%)`,
                  }}
                >
                  <div className="timeline-clip-waveform">
                    {peaks.map((p, pi) => (
                      <span key={pi} className="timeline-clip-waveform-bar" style={{ height: `${p * 100}%`, background: color }} />
                    ))}
                  </div>
                </div>

                <div className="timeline-clip-info">
                  <span className="drag-handle" draggable={false} title="Drag to reorder">
                    ⠿
                  </span>
                  <span className="timeline-clip-name">Clip {i + 1}</span>
                  <span className="timeline-clip-duration">{formatDuration(duration)}</span>
                  <button
                    type="button"
                    className="timeline-clip-delete"
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
                      getSecondsPerPixel={getSecondsPerPixel}
                      beginGesture={beginGesture}
                      previewUpdate={previewUpdate}
                      commitGesture={commitGesture}
                    />
                    <TrimHandle
                      edge="end"
                      segment={seg}
                      sourceDuration={sourceDuration}
                      disabled={disabled}
                      getSecondsPerPixel={getSecondsPerPixel}
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
                    style={{ left: `${splitLocalPercent}%` }}
                    disabled={disabled || hasIntroOrOutro}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSplit();
                    }}
                    title={hasIntroOrOutro ? 'Not available together with an attached intro/outro yet — remove it first' : 'Split this clip at the playhead'}
                  >
                    ✂ Split
                  </button>
                )}
              </div>
            );
          })}

          {totalDuration > 0 && (
            <div className="timeline-playhead" style={{ left: `${playheadPercent}%` }}>
              <span className="timeline-playhead-badge">{formatDuration(playheadTime)}</span>
            </div>
          )}
        </div>

        <IntroOutroSlot
          kind="outro"
          clip={outroClip}
          disabled={hasEditedSegments}
          onSelect={onSelectOutroFile}
          onClear={onClearOutroFile}
          onSetHoldDuration={onSetOutroImageDuration}
        />
      </div>
    </div>
  );
}

interface TrimHandleProps {
  edge: 'start' | 'end';
  segment: EditorSegment;
  sourceDuration: number;
  disabled: boolean;
  getSecondsPerPixel: () => number;
  beginGesture: () => void;
  previewUpdate: (mutate: (prev: EditorSegment[]) => EditorSegment[]) => void;
  commitGesture: () => void;
}

function TrimHandle({ edge, segment, sourceDuration, disabled, getSecondsPerPixel, beginGesture, previewUpdate, commitGesture }: TrimHandleProps) {
  const dragStartRef = useRef<{ x: number; value: number; secondsPerPixel: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = {
      x: e.clientX,
      value: edge === 'start' ? segment.sourceStart : segment.sourceEnd,
      secondsPerPixel: getSecondsPerPixel(),
    };
    beginGesture();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const deltaSec = (e.clientX - start.x) * start.secondsPerPixel;
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
