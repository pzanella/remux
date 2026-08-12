import { useRef, useState } from 'react';
import type { ClipFile } from '../hooks/useTranscoder';

// Intro/outro clips are spliced in via the same fixed-PID MPEG-TS byte-copy
// path the main content uses (see remux.worker.ts's "Intro/outro splicing"
// section) — no FFmpeg pre-conversion step exists for them the way there is
// for the main file, so only formats the Rust remuxer can read directly are
// accepted here.
export const NATIVE_ACCEPT = '.mp4,.mov,.m4v,.3gp,.f4v';
// A dub track's own video (if any) is never used — only its audio track is
// read (see remuxDubAudioTrack) — so this also accepts audio-only formats,
// normalized to AAC/M4A by FFmpeg if they aren't already MP4-family.
const DUB_AUDIO_ACCEPT = '.mp3,.wav,.aac,.m4a,.mp4,.mov,.m4v';

interface DubAudioTrack {
  fileName: string;
  label: string;
  language: string;
}

interface MediaExtrasPanelProps {
  introFile: ClipFile | null;
  outroFile: ClipFile | null;
  onSelectIntroFile: (file: File) => void;
  onClearIntroFile: () => void;
  onSelectOutroFile: (file: File) => void;
  onClearOutroFile: () => void;
  dubAudioTracks: DubAudioTrack[];
  onSelectDubAudioTrack: (file: File) => void;
  onRemoveDubAudioTrack: (fileName: string) => void;
  onSetDubAudioTrackLanguage: (fileName: string, language: string) => void;
  /** Intro/outro splicing and a trimmed/split timeline aren't supported
   * together yet (see remux.worker.ts's own guard in runTranscoding) — the
   * worker used to be the only place this was ever caught, as a runtime
   * error after Start. Disabling the picker here instead means the
   * incompatible combination is never reachable in the first place. */
  hasEditedSegments: boolean;
}

function FilePickerButton({
  label,
  accept,
  onSelect,
  disabled,
  title,
}: {
  label: string;
  accept: string;
  onSelect: (file: File) => void;
  disabled?: boolean;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={disabled} title={title}>
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Intro/outro clips and dub-audio tracks — a persistent, collapsed-by-
 * default strip shown throughout editing (rendered in App.tsx, next to
 * TopBar) rather than tucked inside the export review screen, so they're
 * discoverable without having to click "Export HLS" first. Subtitles used
 * to live here too but moved to `CaptionLane` — unlike these two, subtitle
 * cues need to be placed against a moment in the footage, which this
 * collapsed-strip shape has no room for; intro/outro and dub-audio are
 * whole-file attachments with no such placement problem, so a compact
 * strip is enough for them. */
export default function MediaExtrasPanel({
  introFile,
  outroFile,
  onSelectIntroFile,
  onClearIntroFile,
  onSelectOutroFile,
  onClearOutroFile,
  dubAudioTracks,
  onSelectDubAudioTrack,
  onRemoveDubAudioTrack,
  onSetDubAudioTrackLanguage,
  hasEditedSegments,
}: MediaExtrasPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const attachedCount = (introFile ? 1 : 0) + (outroFile ? 1 : 0) + dubAudioTracks.length;
  const summary =
    attachedCount === 0
      ? 'Intro/outro · Dub audio'
      : `Intro/outro · Dub audio — ${attachedCount} attached`;

  return (
    <div className="extras-strip">
      <button type="button" className="extras-strip-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        <span className="panel-hint">{summary}</span>
        <span className="extras-strip-chevron">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="extras-strip-body">
          <div className="extras-section">
            <span className="panel-hint">Intro / outro</span>
            {hasEditedSegments && (
              <span className="extras-warning">
                Not available together with a trimmed/split timeline yet — undo those edits first.
              </span>
            )}
            <div className="extras-row">
              {introFile ? (
                <span className="extras-item">
                  <span className="extras-item-name">Intro: {introFile.label}</span>
                  <button type="button" className="extras-item-remove" onClick={onClearIntroFile} title="Remove intro">
                    ✕
                  </button>
                </span>
              ) : (
                <FilePickerButton
                  label="+ Intro"
                  accept={NATIVE_ACCEPT}
                  onSelect={onSelectIntroFile}
                  disabled={hasEditedSegments}
                  title={hasEditedSegments ? 'Not available together with a trimmed/split timeline yet' : undefined}
                />
              )}
              {outroFile ? (
                <span className="extras-item">
                  <span className="extras-item-name">Outro: {outroFile.label}</span>
                  <button type="button" className="extras-item-remove" onClick={onClearOutroFile} title="Remove outro">
                    ✕
                  </button>
                </span>
              ) : (
                <FilePickerButton
                  label="+ Outro"
                  accept={NATIVE_ACCEPT}
                  onSelect={onSelectOutroFile}
                  disabled={hasEditedSegments}
                  title={hasEditedSegments ? 'Not available together with a trimmed/split timeline yet' : undefined}
                />
              )}
            </div>
          </div>

          <div className="extras-section">
            <span className="panel-hint">Dub audio</span>
            <div className="dub-audio-list">
              {dubAudioTracks.map((track) => (
                <div key={track.fileName} className="extras-row">
                  <span className="extras-item">
                    <span className="extras-item-name">{track.label}</span>
                    <button
                      type="button"
                      className="extras-item-remove"
                      onClick={() => onRemoveDubAudioTrack(track.fileName)}
                      title={`Remove ${track.label}`}
                    >
                      ✕
                    </button>
                  </span>
                  <input
                    type="text"
                    className="text-input"
                    value={track.language}
                    onChange={(e) => onSetDubAudioTrackLanguage(track.fileName, e.target.value)}
                    title="BCP-47 language code, e.g. en, it, fr"
                  />
                </div>
              ))}
              <div className="extras-row">
                <FilePickerButton label="+ Dub audio track" accept={DUB_AUDIO_ACCEPT} onSelect={onSelectDubAudioTrack} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
