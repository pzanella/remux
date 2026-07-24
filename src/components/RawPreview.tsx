import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ClipKind } from './Timeline';

export interface SeekCommand {
  clip: ClipKind;
  time: number;
  nonce: number;
  /** Set when the seek is part of the intro→main→outro auto-advance chain
   * (see App's `handleEnded`) — a plain scrub/click shouldn't start
   * playback on its own, but reaching the end of one clip and moving to
   * the next should keep playing through the cut without the user having
   * to press play again. */
  autoplay?: boolean;
}

export interface RawPreviewHandle {
  togglePlayPause: () => void;
}

interface RawPreviewProps {
  selectedClip: ClipKind | null;
  sourceFile: File | null;
  introFile: File | null;
  outroFile: File | null;
  seek: SeekCommand | null;
  muted: boolean;
  onTimeUpdate: (localTime: number) => void;
  onEnded: () => void;
}

/** Preview of whichever clip is selected on the timeline — the raw uploaded
 * file, played directly via a blob URL, not a real composited render. It
 * only ever plays one `<video>` at a time; the intro → main → outro
 * continuity comes from the parent switching which file is loaded on
 * `onEnded` and re-seeking with `autoplay`, not from anything this
 * component does on its own. Once a conversion starts and produces real
 * HLS output, `Player` takes over instead. */
const RawPreview = forwardRef<RawPreviewHandle, RawPreviewProps>(function RawPreview(
  { selectedClip, sourceFile, introFile, outroFile, seek, muted, onTimeUpdate, onEnded },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [label, setLabel] = useState('');

  const file = selectedClip === 'intro' ? introFile : selectedClip === 'outro' ? outroFile : sourceFile;

  useImperativeHandle(ref, () => ({
    togglePlayPause: () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) void video.play();
      else video.pause();
    },
  }));

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLabel(selectedClip ?? 'main');
    if (videoRef.current) videoRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, selectedClip]);

  useEffect(() => {
    const video = videoRef.current;
    if (!seek || !video) return;
    const applySeek = () => {
      video.currentTime = seek.time;
      if (seek.autoplay) void video.play();
    };
    if (video.readyState >= 1) applySeek();
    else video.addEventListener('loadedmetadata', applySeek, { once: true });
  }, [seek]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, file]);

  return (
    <div className="panel">
      <div className="panel-row panel-row--split">
        <span className="section-label-row">
          <span className="section-label">Editing preview</span>
          <span
            className="preview-badge preview-badge--editing"
            title="Plays intro → video → outro back to back so you can check the cut. Press Start to package the real HLS output."
          >
            Draft
          </span>
        </span>
        {file && <span className="status-line">{label}</span>}
      </div>
      <div className="player-frame">
        {file ? (
          <video ref={videoRef} controls onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)} onEnded={onEnded} />
        ) : (
          <p className="player-placeholder">Add a video to the timeline to preview it here.</p>
        )}
      </div>
      {!file && (
        <p className="panel-hint">
          Plays intro → video → outro back to back so you can check the cut. Press Start to package the real HLS
          output, shown with the full player below.
        </p>
      )}
    </div>
  );
});

export default RawPreview;
