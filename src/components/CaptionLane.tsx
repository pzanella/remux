import { useMemo, useRef, useState } from 'react';
import SubtitleCueEditor from './SubtitleCueEditor';
import { type EditorSegment, flattenedDuration, locateGlobalTime, remapSourceRangeToGlobal } from '../lib/segments';
import { parseCues, serializeVtt } from '../lib/vtt';

const SUBTITLE_ACCEPT = '.srt,.vtt';
/** Clamped to the owning segment's own end, so this is a ceiling, not a
 * guarantee. */
const NEW_CUE_DURATION_SEC = 2;

interface SubtitleTrack {
  fileName: string;
  label: string;
  language: string;
}

interface CaptionLaneProps {
  segments: EditorSegment[];
  playheadTime: number;
  onPlayheadChange: (time: number) => void;
  subtitleTracks: SubtitleTrack[];
  subtitleVttTextByFile: Record<string, string>;
  onSelectSubtitleFile: (file: File) => void;
  onAddBlankSubtitleTrack: () => Promise<string | null>;
  onRemoveSubtitleTrack: (fileName: string) => void;
  onSetSubtitleTrackLanguage: (fileName: string, language: string) => void;
  onSaveSubtitleEdits: (fileName: string, vttText: string) => Promise<void>;
}

/**
 * Persistent caption strip under the preview — visible throughout editing,
 * not tucked inside the export review screen — showing each subtitle
 * track's cues as blocks positioned against the *actual* (possibly
 * trimmed/split/reordered) output timeline, via the same
 * `remapSourceRangeToGlobal` the worker itself uses to build the real
 * export. What you see here is what ships: a cue that falls outside every
 * current segment (trimmed away, or straddling a cut) is shown as dropped
 * (a warning count, not silently missing) rather than only surfacing as a
 * playback surprise later.
 *
 * Dragging directly on the lane to place/resize a cue isn't implemented —
 * cues are still authored in `SubtitleCueEditor` (typed timestamps, opened
 * per-track from here). What this adds over hiding that editor behind
 * "Export HLS" is visibility (it's here the whole time you're editing) and
 * a "+ Cue" button that grabs the current playhead position instead of
 * typing one blind.
 */
export default function CaptionLane({
  segments,
  playheadTime,
  onPlayheadChange,
  subtitleTracks,
  subtitleVttTextByFile,
  onSelectSubtitleFile,
  onAddBlankSubtitleTrack,
  onRemoveSubtitleTrack,
  onSetSubtitleTrackLanguage,
  onSaveSubtitleEdits,
}: CaptionLaneProps) {
  const [editingFileName, setEditingFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const totalDuration = flattenedDuration(segments);
  const editingTrack = subtitleTracks.find((t) => t.fileName === editingFileName) ?? null;

  // Re-parsing VTT text and remapping every cue is wasted work on every one
  // of the many re-renders `playheadTime` alone causes during playback —
  // memoized so it only redoes the real work when a track's text, the edit
  // itself, or the timeline's own total length actually changes.
  const trackBlocks = useMemo(
    () =>
      subtitleTracks.map((track) => {
        const cues = parseCues(subtitleVttTextByFile[track.fileName] ?? '');
        let droppedCount = 0;
        const blocks = cues.flatMap((cue) => {
          const remapped = totalDuration > 0 ? remapSourceRangeToGlobal(segments, cue.start, cue.end) : null;
          if (!remapped) {
            droppedCount++;
            return [];
          }
          return [
            {
              id: cue.id,
              text: cue.text,
              left: (remapped.start / totalDuration) * 100,
              width: Math.max(0.3, ((remapped.end - remapped.start) / totalDuration) * 100),
            },
          ];
        });
        return { fileName: track.fileName, blocks, droppedCount };
      }),
    [subtitleTracks, subtitleVttTextByFile, segments, totalDuration],
  );

  const scrubAt = (laneEl: HTMLElement, clientX: number) => {
    if (totalDuration <= 0) return;
    const rect = laneEl.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onPlayheadChange(fraction * totalDuration);
  };

  const addCueAtPlayhead = async (track: SubtitleTrack) => {
    const loc = locateGlobalTime(segments, playheadTime);
    if (!loc) return;
    const start = loc.localSourceTime;
    const end = Math.min(loc.segment.sourceEnd, start + NEW_CUE_DURATION_SEC);
    const cues = parseCues(subtitleVttTextByFile[track.fileName] ?? '');
    cues.push({ id: `cue-new-${Date.now()}`, start, end, text: '' });
    // Must await the save before opening the editor — it reads
    // `subtitleVttTextByFile` (updated by the save, asynchronously) as its
    // starting point, so opening it first would show the pre-add text and
    // silently lose this cue the moment the editor's own Save overwrites
    // the file with what it had.
    await onSaveSubtitleEdits(track.fileName, serializeVtt(cues));
    setEditingFileName(track.fileName);
  };

  return (
    <div className="caption-lane">
      {subtitleTracks.length === 0 ? (
        <div className="caption-lane-empty">
          <span className="panel-hint">Captions</span>
          <button type="button" className="btn-quiet" onClick={() => fileInputRef.current?.click()}>
            + Add captions
          </button>
          <button
            type="button"
            className="btn-quiet"
            onClick={async () => {
              const fileName = await onAddBlankSubtitleTrack();
              if (fileName) setEditingFileName(fileName);
            }}
          >
            + Write from scratch
          </button>
        </div>
      ) : (
        <>
          {subtitleTracks.map((track, i) => {
            const { blocks, droppedCount } = trackBlocks[i];

            return (
              <div key={track.fileName} className="caption-track-row">
                <div className="caption-track-header">
                  <span className="extras-item-name">{track.label}</span>
                  <input
                    type="text"
                    className="text-input"
                    value={track.language}
                    onChange={(e) => onSetSubtitleTrackLanguage(track.fileName, e.target.value)}
                    title="BCP-47 language code, e.g. en, it, fr"
                  />
                  {droppedCount > 0 && (
                    <span
                      className="caption-track-warning"
                      title={`${droppedCount} cue(s) fall outside the current edit and will be dropped at export`}
                    >
                      ⚠ {droppedCount}
                    </span>
                  )}
                  <button type="button" className="btn-quiet" onClick={() => addCueAtPlayhead(track)}>
                    + Cue
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => setEditingFileName(track.fileName)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="extras-item-remove"
                    onClick={() => onRemoveSubtitleTrack(track.fileName)}
                    title={`Remove ${track.label}`}
                  >
                    ✕
                  </button>
                </div>
                <div className="caption-track-lane" onPointerDown={(e) => scrubAt(e.currentTarget, e.clientX)}>
                  {blocks.map((b) => (
                    <div
                      key={b.id}
                      className="caption-cue-block"
                      style={{ left: `${b.left}%`, width: `${b.width}%` }}
                      title={b.text || '(empty cue)'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingFileName(track.fileName);
                      }}
                    />
                  ))}
                  {totalDuration > 0 && (
                    <div className="caption-lane-playhead" style={{ left: `${(playheadTime / totalDuration) * 100}%` }} />
                  )}
                </div>
              </div>
            );
          })}
          <div className="caption-lane-footer">
            <button type="button" className="btn-quiet" onClick={() => fileInputRef.current?.click()}>
              + Add track
            </button>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={SUBTITLE_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelectSubtitleFile(file);
          e.target.value = '';
        }}
      />

      {editingTrack && (
        <SubtitleCueEditor
          vttText={subtitleVttTextByFile[editingTrack.fileName] ?? ''}
          language={editingTrack.language}
          onLanguageChange={(language) => onSetSubtitleTrackLanguage(editingTrack.fileName, language)}
          onSave={async (vtt) => {
            await onSaveSubtitleEdits(editingTrack.fileName, vtt);
            setEditingFileName(null);
          }}
          onClose={() => setEditingFileName(null)}
        />
      )}
    </div>
  );
}
