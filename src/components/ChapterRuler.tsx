import { useState } from 'react';
import type { ChapterMark } from '../lib/chapters';
import { type EditorSegment, flattenedDuration } from '../lib/segments';
import { formatTimestamp } from '../lib/vtt';

interface ChapterRulerProps {
  segments: EditorSegment[];
  playheadTime: number;
  onPlayheadChange: (time: number) => void;
  chapters: ChapterMark[];
  onAddChapterAt: (time: number) => string;
  onRenameChapter: (id: string, title: string) => void;
  onRemoveChapter: (id: string) => void;
}

/**
 * A thin marker ruler under `CaptionLane`, same "persistent, visible
 * throughout editing" placement — diamond markers along the *output*
 * timeline (see `lib/chapters.ts`'s own doc comment for why chapters use
 * global, not source-relative, coordinates). Clicking an existing marker
 * selects it for inline rename/delete; "+ Chapter here" drops a new one at
 * the current playhead.
 */
export default function ChapterRuler({
  segments,
  playheadTime,
  onPlayheadChange,
  chapters,
  onAddChapterAt,
  onRenameChapter,
  onRemoveChapter,
}: ChapterRulerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const totalDuration = flattenedDuration(segments);
  const selected = chapters.find((c) => c.id === selectedId) ?? null;
  const droppedCount = totalDuration > 0 ? chapters.filter((c) => c.time >= totalDuration).length : 0;

  const scrubAt = (laneEl: HTMLElement, clientX: number) => {
    if (totalDuration <= 0) return;
    const rect = laneEl.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onPlayheadChange(fraction * totalDuration);
  };

  return (
    <div className="chapter-ruler">
      <div className="chapter-ruler-header">
        <span className="panel-hint">Chapters</span>
        {droppedCount > 0 && (
          <span
            className="caption-track-warning"
            title={`${droppedCount} chapter(s) fall outside the current edit and will be dropped at export`}
          >
            ⚠ {droppedCount}
          </span>
        )}
        <button type="button" className="btn-quiet" onClick={() => setSelectedId(onAddChapterAt(playheadTime))}>
          + Chapter here
        </button>
      </div>
      <div className="chapter-ruler-lane" onPointerDown={(e) => scrubAt(e.currentTarget, e.clientX)}>
        {chapters.map((c) => (
          <button
            key={c.id}
            type="button"
            className={
              'chapter-marker' +
              (c.id === selectedId ? ' chapter-marker--selected' : '') +
              (c.time >= totalDuration ? ' chapter-marker--dropped' : '')
            }
            style={{ left: `${totalDuration > 0 ? (c.time / totalDuration) * 100 : 0}%` }}
            title={`${c.title || 'Chapter'} — ${formatTimestamp(c.time)}`}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedId((sel) => (sel === c.id ? null : c.id));
            }}
          />
        ))}
        {totalDuration > 0 && (
          <div className="chapter-ruler-playhead" style={{ left: `${(playheadTime / totalDuration) * 100}%` }} />
        )}
      </div>
      {selected && (
        <div className="chapter-editor-row">
          <input
            type="text"
            className="text-input"
            value={selected.title}
            onChange={(e) => onRenameChapter(selected.id, e.target.value)}
            placeholder="Chapter title"
            autoFocus
          />
          <span className="panel-hint">{formatTimestamp(selected.time)}</span>
          <button
            type="button"
            className="extras-item-remove"
            onClick={() => {
              onRemoveChapter(selected.id);
              setSelectedId(null);
            }}
            title="Delete chapter"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
