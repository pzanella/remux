import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type EditorSegment, flattenedDuration, globalTimeForLocation, locateGlobalTime } from '../lib/segments';
import RenditionChips from './RenditionChips';

export interface PreviewPaneHandle {
  togglePlayPause: () => void;
}

/** Everything the preview needs to actually play an attached intro/outro
 * clip — a trimmed-down projection of `ClipFile` (useTranscoder.ts), not
 * the whole thing (this component has no use for its OPFS filename). */
export interface PreviewClip {
  file: File;
  duration: number;
  isImage?: boolean;
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
  introClip?: PreviewClip | null;
  outroClip?: PreviewClip | null;
}

function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** Which of the three real sources — intro clip, main content, outro clip —
 * is currently loaded/playing. `'main'` is the only phase the rest of the
 * editor (Timeline/CaptionLane/ChapterRuler) knows or cares about: they all
 * reason purely in main-content-relative time via `playheadTime`, exactly
 * as before this file gained intro/outro support. Intro/outro playback
 * position (`phaseElapsed` below) lives entirely locally in this component
 * instead — there's nothing for it to synchronize against elsewhere, since
 * intro/outro have no cues/chapters/split points of their own. */
type Phase = 'intro' | 'main' | 'outro';

/** A native `<video>` playing straight from the loaded `sourceFile` for the
 * main-content phase — driven entirely by the flattened (post-edit)
 * `playheadTime`: segment trim/split/delete/reorder never touches the file
 * itself, only which ranges of it play and in what order, so this just
 * seeks within one File and jumps across trim boundaries during playback.
 * An attached intro/outro clip swaps the same `<video>` element (or an
 * `<img>` overlay, for a still image) to its own file for its own phase,
 * auto-advancing at each boundary — intro end → main start, main's last
 * segment end → outro start (or just stop, with no outro attached) — the
 * same sequence the final spliced export actually produces.
 */
const PreviewPane = forwardRef<PreviewPaneHandle, PreviewPaneProps>(function PreviewPane(
  {
    sourceFile,
    segments,
    playheadTime,
    onPlayheadChange,
    disabled,
    abrHeights,
    sourceResolution,
    onToggleAbrHeight,
    introClip,
    outroClip,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const currentIndexRef = useRef(0);

  const [phase, setPhase] = useState<Phase>('intro');
  // Whether the user has asked for playback to be running — set only by
  // `toggleImageOrVideoPlayback` (an explicit play/pause), never by the
  // native `pause` event: a video's natural end-of-playback fires `pause`
  // *before* `ended` (see handleEnded), so reading `isPlaying` state at that
  // point would already see it flipped false and wrongly leave an
  // auto-advanced intro/outro phase stuck paused instead of continuing.
  const shouldPlayRef = useRef(false);
  // Elapsed time within the *current* phase, for intro/outro only — main's
  // own position is `playheadTime`, owned by the editor. Set from native
  // `timeupdate` for a video clip, or ticked by `startImageClock` below for
  // a still image (no native timeupdate to hook into there).
  const [phaseElapsed, setPhaseElapsed] = useState(0);
  const rafRef = useRef<number | null>(null);
  const rafLastTsRef = useRef<number | null>(null);

  const sourceUrlRef = useRef<string | null>(null);
  const introUrlRef = useRef<string | null>(null);
  const outroUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sourceFile) {
      sourceUrlRef.current = null;
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    sourceUrlRef.current = url;
    return () => {
      URL.revokeObjectURL(url);
      sourceUrlRef.current = null;
    };
  }, [sourceFile]);

  useEffect(() => {
    if (!introClip) {
      introUrlRef.current = null;
      return;
    }
    const url = URL.createObjectURL(introClip.file);
    introUrlRef.current = url;
    return () => {
      URL.revokeObjectURL(url);
      introUrlRef.current = null;
    };
  }, [introClip]);

  useEffect(() => {
    if (!outroClip) {
      outroUrlRef.current = null;
      return;
    }
    const url = URL.createObjectURL(outroClip.file);
    outroUrlRef.current = url;
    return () => {
      URL.revokeObjectURL(url);
      outroUrlRef.current = null;
    };
  }, [outroClip]);

  function stopImageClock() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    rafLastTsRef.current = null;
  }

  /** Drives `phaseElapsed` for a still-image intro/outro phase, since
   * there's no native `<video>` timeupdate to hook into — ticks at real
   * wall-clock rate while playing, same as native playback would. */
  function startImageClock(durationSec: number, onDone: () => void) {
    stopImageClock();
    const tick = (ts: number) => {
      const last = rafLastTsRef.current;
      rafLastTsRef.current = ts;
      if (last !== null) {
        const deltaSec = (ts - last) / 1000;
        setPhaseElapsed((prev) => {
          const next = prev + deltaSec;
          if (next >= durationSec) {
            stopImageClock();
            onDone();
            return durationSec;
          }
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function switchToIntro(elapsed: number) {
    stopImageClock();
    setPhase('intro');
    setPhaseElapsed(elapsed);
    if (!introClip) return;
    if (introClip.isImage) {
      if (shouldPlayRef.current) startImageClock(introClip.duration, () => switchToMain(0));
      return;
    }
    const video = videoRef.current;
    if (video) {
      const url = introUrlRef.current;
      if (url && video.currentSrc !== url) video.src = url;
      video.currentTime = elapsed;
    }
  }

  function switchToMain(localMainTime: number) {
    stopImageClock();
    setPhase('main');
    const video = videoRef.current;
    if (video && sourceUrlRef.current) {
      if (video.currentSrc !== sourceUrlRef.current) video.src = sourceUrlRef.current;
      const loc = locateGlobalTime(segments, localMainTime);
      if (loc) {
        currentIndexRef.current = loc.index;
        video.currentTime = loc.localSourceTime;
      }
    }
    onPlayheadChange(Math.min(localMainTime, mainDuration));
    if (shouldPlayRef.current) void video?.play().catch(() => {});
  }

  function switchToOutro(elapsed: number) {
    stopImageClock();
    setPhase('outro');
    setPhaseElapsed(elapsed);
    if (!outroClip) return;
    if (outroClip.isImage) {
      if (shouldPlayRef.current) startImageClock(outroClip.duration, () => setIsPlaying(false));
      return;
    }
    const video = videoRef.current;
    if (video) {
      const url = outroUrlRef.current;
      if (url && video.currentSrc !== url) video.src = url;
      video.currentTime = elapsed;
      if (shouldPlayRef.current) void video.play().catch(() => {});
    }
  }

  // A newly-loaded source always starts at the very front of the preview —
  // the intro if there is one, main content otherwise. Re-evaluated
  // whenever what's attached changes (e.g. an intro just got added/removed)
  // so the preview never gets stuck showing a phase that no longer exists.
  useEffect(() => {
    if (introClip) {
      switchToIntro(0);
    } else {
      switchToMain(0);
    }
    // Only re-run on a genuine identity change of sourceFile/introClip, not
    // on every playheadTime tick (which would fight the phase's own
    // playback) or a switchToX redefinition (a fresh closure every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFile, introClip]);

  const mainDuration = flattenedDuration(segments);
  const introDuration = introClip?.duration ?? 0;
  const outroDuration = outroClip?.duration ?? 0;
  const totalDuration = introDuration + mainDuration + outroDuration;

  // An external playhead change (Timeline click, undo, split jumping the
  // selection) needs to seek — but only while already in the main phase;
  // during intro/outro this would otherwise yank playback back to main
  // content the instant some other lane's own effect reads `playheadTime`.
  useEffect(() => {
    if (phase !== 'main') return;
    const video = videoRef.current;
    if (!video || segments.length === 0) return;
    const loc = locateGlobalTime(segments, playheadTime);
    if (!loc) return;
    currentIndexRef.current = loc.index;
    // Tolerance distinguishes "someone moved the playhead" from "the video
    // is just playing forward and timeupdate is echoing its own position".
    if (Math.abs(video.currentTime - loc.localSourceTime) > 0.35) {
      video.currentTime = loc.localSourceTime;
    }
  }, [playheadTime, segments, phase]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    if (phase !== 'main') {
      setPhaseElapsed(video.currentTime);
      return;
    }

    if (segments.length === 0) return;
    const idx = currentIndexRef.current;
    const seg = segments[idx];
    if (!seg) return;

    if (video.currentTime >= seg.sourceEnd - 0.02) {
      const nextIdx = idx + 1;
      if (nextIdx < segments.length) {
        currentIndexRef.current = nextIdx;
        video.currentTime = segments[nextIdx].sourceStart;
        onPlayheadChange(globalTimeForLocation(segments, nextIdx, segments[nextIdx].sourceStart));
      } else if (outroClip) {
        switchToOutro(0);
      } else {
        video.pause();
        onPlayheadChange(flattenedDuration(segments));
      }
      return;
    }
    onPlayheadChange(globalTimeForLocation(segments, idx, video.currentTime));
  };

  const handleEnded = () => {
    // Main content's own "ran out of segments" is handled in
    // handleTimeUpdate above (it fires before a real `ended` event would,
    // since it jumps `currentTime` back for the next segment or switches
    // phase entirely) — this only ever fires for intro/outro's own video.
    if (phase === 'intro') switchToMain(0);
    // Outro ending is just the end of the whole preview; native `pause`
    // state already reflects that once playback stops.
  };

  const activeImageClip = phase === 'intro' ? (introClip?.isImage ? introClip : null) : phase === 'outro' ? (outroClip?.isImage ? outroClip : null) : null;

  const toggleImageOrVideoPlayback = () => {
    if (activeImageClip) {
      if (isPlaying) {
        shouldPlayRef.current = false;
        stopImageClock();
        setIsPlaying(false);
      } else {
        shouldPlayRef.current = true;
        setIsPlaying(true);
        // Pass the clip's own full duration, not a "remaining time" delta —
        // `phaseElapsed` (the tick's own starting point via its functional
        // `setPhaseElapsed` update) already reflects wherever playback was
        // paused; the done-check compares the running total against this
        // directly, not a countdown.
        startImageClock(activeImageClip.duration, () => (phase === 'intro' ? switchToMain(0) : setIsPlaying(false)));
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      shouldPlayRef.current = true;
      void video.play();
    } else {
      shouldPlayRef.current = false;
      video.pause();
    }
  };

  useImperativeHandle(ref, () => ({ togglePlayPause: toggleImageOrVideoPlayback }));

  // Global preview-timeline position, spanning intro + main + outro — what
  // the scrub bar and timecode actually show, distinct from `playheadTime`
  // (main-content-relative only, shared with the rest of the editor).
  const globalPreviewTime =
    phase === 'intro' ? phaseElapsed : phase === 'main' ? introDuration + playheadTime : introDuration + mainDuration + phaseElapsed;

  const scrubAt = (clientX: number) => {
    const el = scrubRef.current;
    if (!el || totalDuration <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const target = fraction * totalDuration;
    if (target < introDuration) {
      switchToIntro(target);
    } else if (target < introDuration + mainDuration) {
      switchToMain(target - introDuration);
    } else {
      switchToOutro(Math.min(outroDuration, target - introDuration - mainDuration));
    }
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

  const scrubPercent = totalDuration > 0 ? Math.min(100, (globalPreviewTime / totalDuration) * 100) : 0;
  const activeImageUrl = phase === 'intro' ? introUrlRef.current : phase === 'outro' ? outroUrlRef.current : null;

  return (
    <div className="preview-pane">
      <div className="preview-frame">
        <video
          ref={videoRef}
          playsInline
          style={activeImageClip ? { visibility: 'hidden' } : undefined}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
        />
        {activeImageClip && activeImageUrl && <img className="preview-still" src={activeImageUrl} alt="" />}
      </div>

      <div className="preview-controls">
        <button
          type="button"
          className="transport-btn"
          onClick={toggleImageOrVideoPlayback}
          disabled={disabled || totalDuration <= 0}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>

        <span className="timecode">
          {formatTimecode(globalPreviewTime)} <span className="timecode-sep">/</span> {formatTimecode(totalDuration)}
        </span>

        <div
          ref={scrubRef}
          className="scrub-bar"
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
        >
          {introDuration > 0 && <div className="scrub-bar-marker" style={{ left: `${(introDuration / totalDuration) * 100}%` }} />}
          {outroDuration > 0 && <div className="scrub-bar-marker" style={{ left: `${((introDuration + mainDuration) / totalDuration) * 100}%` }} />}
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
