import { useRef, useState } from 'react';

// Intro/outro clips are spliced in via the same fixed-PID MPEG-TS byte-copy
// path the main content uses (see remux.worker.ts's "Intro/outro splicing"
// section) — no FFmpeg pre-conversion step exists for native-video intro/
// outro the way there is for the main file, so only formats the Rust
// remuxer can read directly are accepted for those. A still image is the
// one exception: the worker synthesizes a short held video clip from it
// first (see `convertImageToClip`), so it never touches the Rust remuxer
// directly and isn't bound by that same-container restriction. Exported for
// `Timeline.tsx`'s own intro/outro slots, which now own the picker/drop UI
// this component used to (see that file's own `IntroOutroSlot`).
export const NATIVE_ACCEPT = '.mp4,.mov,.m4v,.3gp,.f4v,.jpg,.jpeg,.png,.webp';
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
  dubAudioTracks: DubAudioTrack[];
  onSelectDubAudioTrack: (file: File) => void;
  onRemoveDubAudioTrack: (fileName: string) => void;
  onSetDubAudioTrackLanguage: (fileName: string, language: string) => void;
}

function FilePickerButton({
  label,
  accept,
  onSelect,
}: {
  label: string;
  accept: string;
  onSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
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

/** Dub-audio tracks — a persistent, collapsed-by-default strip shown
 * throughout editing (rendered in App.tsx, directly under the Timeline)
 * rather than tucked inside the export review screen, so it's discoverable
 * without having to click "Export HLS" first. Intro/outro used to live here
 * too but moved into `Timeline.tsx`'s own flanking slots — visible in the
 * timeline itself, where they actually belong — and subtitles/chapters live
 * in their own lanes (`CaptionLane`/`ChapterRuler`) for the same reason:
 * this compact strip only really suits whole-file attachments with no
 * placement-in-time concern, which dub-audio still is. */
export default function MediaExtrasPanel({
  dubAudioTracks,
  onSelectDubAudioTrack,
  onRemoveDubAudioTrack,
  onSetDubAudioTrackLanguage,
}: MediaExtrasPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const summary = dubAudioTracks.length === 0 ? 'Dub audio' : `Dub audio — ${dubAudioTracks.length} attached`;

  return (
    <div className="extras-strip">
      <button type="button" className="extras-strip-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        <span className="panel-hint">{summary}</span>
        <span className="extras-strip-chevron">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="extras-strip-body">
          <div className="extras-section">
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
