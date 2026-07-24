import { useState } from 'react';
import { formatTimestamp, parseCues, serializeVtt, type Cue } from '../lib/vtt';

/** Parses `HH:MM:SS.mmm`, `MM:SS.mmm`, or plain seconds — whatever's least
 * fiddly to type while nudging a cue's timing. Falls back to the previous
 * value on anything unparseable rather than silently zeroing it out. */
function parseTimeInput(value: string, fallback: number): number {
  const parts = value.trim().split(':');
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) ? n : fallback;
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return fallback;
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

let nextCueId = 0;

interface SubtitleCueEditorProps {
  vttText: string;
  language: string;
  onLanguageChange: (language: string) => void;
  onSave: (vttText: string) => void;
  onClose: () => void;
}

export default function SubtitleCueEditor({ vttText, language, onLanguageChange, onSave, onClose }: SubtitleCueEditorProps) {
  const [cues, setCues] = useState<Cue[]>(() => parseCues(vttText));

  const updateCue = (id: string, patch: Partial<Cue>) => {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCue = (id: string) => setCues((prev) => prev.filter((c) => c.id !== id));

  const addCue = () => {
    const last = cues[cues.length - 1];
    const start = last ? last.end + 0.5 : 0;
    setCues((prev) => [...prev, { id: `new-${nextCueId++}`, start, end: start + 3, text: '' }]);
  };

  return (
    <div className="cue-editor-backdrop" onClick={onClose}>
      <div className="cue-editor" onClick={(e) => e.stopPropagation()}>
        <div className="cue-editor-header">
          <span className="section-label">Edit subtitles</span>
          <label className="cue-editor-lang">
            <span className="panel-hint">Language</span>
            <input type="text" className="text-input" value={language} onChange={(e) => onLanguageChange(e.target.value)} />
          </label>
          <button className="btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="cue-editor-list">
          {cues.length === 0 && <p className="panel-hint">No cues yet — add one to start writing.</p>}
          {cues.map((cue) => (
            <div key={cue.id} className="cue-row">
              <div className="cue-row-times">
                <input
                  type="text"
                  className="text-input cue-time-input"
                  value={formatTimestamp(cue.start)}
                  onChange={(e) => updateCue(cue.id, { start: parseTimeInput(e.target.value, cue.start) })}
                />
                <span className="panel-hint">→</span>
                <input
                  type="text"
                  className="text-input cue-time-input"
                  value={formatTimestamp(cue.end)}
                  onChange={(e) => updateCue(cue.id, { end: parseTimeInput(e.target.value, cue.end) })}
                />
              </div>
              <textarea
                className="cue-text-input"
                value={cue.text}
                onChange={(e) => updateCue(cue.id, { text: e.target.value })}
                rows={2}
              />
              <button className="btn-quiet" onClick={() => removeCue(cue.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="btn-row">
          <button className="btn" onClick={addCue}>
            + Add cue
          </button>
          <button className="btn btn-primary" onClick={() => onSave(serializeVtt(cues))}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
