import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type EditorSegment, flattenedDuration, globalTimeForLocation, locateGlobalTime } from '../lib/segments';
import RenditionChips from './RenditionChips';

export interface PreviewPaneHandle {
  togglePlayPause: () => void;
}

interface PreviewPaneProps {
  sourceFile: File | null;
  segments: EditorSegment[];
  playheadTime: number;
  onPlayheadChange: (time: number) => void;
  disabled: boolean;
  abrHeights: number[];
  sourceResolution: { width: number; height: number } | null;
  onToggleAbrHeight: (height: number) => void;
}

function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** A native `<video>` playing straight from the one loaded `sourceFile`,
 * driven entirely by the flattened (post-edit) playhead: segment trim/
 * split/delete/reorder never touches the file itself, only which ranges of
 * it play and in what order — so the preview just seeks within one File
 * and jumps across trim boundaries during playback, instead of chaining
 * between several separate clip files the way the old intro/main/outro
 * preview did. */
const PreviewPane = forwardRef<PreviewPaneHandle, PreviewPaneProps>(function PreviewPane(
  { sourceFile, segments, playheadTime, onPlayheadChange, disabled, abrHeights, sourceResolution, onToggleAbrHeight },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const currentIndexRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceFile) return;
    const url = URL.createObjectURL(sourceFile);
    video.src = url;
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  // An external playhead change (rail click, scrub-bar drag, split/undo
  // jumping the selection) needs to seek the video — but our own
  // `timeupdate` handler below also feeds playhead changes back up, so a
  // tolerance is used to tell "someone moved the playhead" apart from "the
  // video is just playing forward and we're echoing its own position".
  useEffect(() => {
    const video = videoRef.current;
    if (!video || segments.length === 0) return;
    const loc = locateGlobalTime(segments, playheadTime);
    if (!loc) return;
    currentIndexRef.current = loc.index;
    if (Math.abs(video.currentTime - loc.localSourceTime) > 0.35) {
      video.currentTime = loc.localSourceTime;
    }
  }, [playheadTime, segments]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || segments.length === 0) return;
    const idx = currentIndexRef.current;
    const seg = segments[idx];
    if (!seg) return;

    if (video.currentTime >= seg.sourceEnd - 0.02) {
      const nextIdx = idx + 1;
      if (nextIdx < segments.length) {
        currentIndexRef.current = nextIdx;
        video.currentTime = segments[nextIdx].sourceStart;
        onPlayheadChange(globalTimeForLocation(segments, nextIdx, segments[nextIdx].sourceStart));
      } else {
        video.pause();
        onPlayheadChange(flattenedDuration(segments));
      }
      return;
    }
    onPlayheadChange(globalTimeForLocation(segments, idx, video.currentTime));
  };

  useImperativeHandle(ref, () => ({
    togglePlayPause: () => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) void video.play();
      else video.pause();
    },
  }));

  const totalDuration = flattenedDuration(segments);

  const scrubAt = (clientX: number) => {
    const el = scrubRef.current;
    if (!el || totalDuration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onPlayheadChange(fraction * totalDuration);
  };

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (totalDuration <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  };
  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    scrubAt(e.clientX);
  };

  const scrubPercent = totalDuration > 0 ? Math.min(100, (playheadTime / totalDuration) * 100) : 0;

  return (
    <div className="preview-pane">
      <div className="preview-frame">
        <video
          ref={videoRef}
          playsInline
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={handleTimeUpdate}
        />
      </div>

      <div className="preview-controls">
        <button
          type="button"
          className="transport-btn"
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.paused) void video.play();
            else video.pause();
          }}
          disabled={disabled || totalDuration <= 0}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>

        <span className="timecode">
          {formatTimecode(playheadTime)} <span className="timecode-sep">/</span> {formatTimecode(totalDuration)}
        </span>

        <div
          ref={scrubRef}
          className="scrub-bar"
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
        >
          <div className="scrub-bar-fill" style={{ width: `${scrubPercent}%` }} />
          <div className="scrub-bar-handle" style={{ left: `${scrubPercent}%` }} />
        </div>
      </div>

      <RenditionChips heights={abrHeights} sourceResolution={sourceResolution} disabled={disabled} onToggleHeight={onToggleAbrHeight} />
    </div>
  );
});

export default PreviewPane;

function IconPlay() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <path d="M4 2.5v11l10-5.5-10-5.5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <rect x="3.5" y="2.5" width="3" height="11" />
      <rect x="9.5" y="2.5" width="3" height="11" />
    </svg>
  );
}
