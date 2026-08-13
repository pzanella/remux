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

interface PreviewSubtitleTrack {
  fileName: string;
  label: string;
  language: string;
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
  /** Live subtitle preview during editing — real `<track kind="subtitles">`
   * elements, browser-native cue rendering, no hand-rolled overlay. Cue
   * text is used as-is from `subtitleVttTextByFile` (source-file-relative
   * timestamps), *not* remapped through `segments` into the flattened
   * output timeline: during the main phase this `<video>` plays straight
   * from `sourceFile` and its own `currentTime` already tracks real source
   * time (see `switchToMain`/`handleTimeUpdate`, which seek/jump it in
   * source-file coordinates per segment) — so source-relative cues line up
   * with the element's own timeline exactly as authored, and a cue whose
   * source range was cut out is simply never reached as `currentTime` jumps
   * across segment boundaries, with no remapping step required. Only
   * meaningful during `phase === 'main'` — intro/outro have no cues. */
  subtitleTracks?: PreviewSubtitleTrack[];
  subtitleVttTextByFile?: Record<string, string>;
  /** Live chapter label during editing — no `<track kind="chapters">`
   * element, since that kind has no default rendering in any browser engine
   * to hook into. `time` is already in the flattened/output timeline's own
   * coordinates (see `lib/chapters.ts`), the same coordinate space as
   * `playheadTime`, so — unlike subtitle cues above — no remapping is
   * needed here either, just a plain last-chapter-at-or-before lookup. */
  chapters?: { time: number; title: string }[];
  /** A dub-audio track selected for live preview (resolved from OPFS back
   * into a real `File` in App.tsx — `useTranscoder`'s own `dubAudioTracks`
   * only keeps the OPFS filename in memory, unlike intro/outro's
   * `ClipFile`). Only meaningful during `phase === 'main'`, same as
   * subtitles above: the dub content only ever covers the main clip.
   * Not frame-accurate sample sync — the same tolerance-based resync this
   * file already uses for segment-jumping, reused here against
   * `playheadTime` rather than `video.currentTime` directly, since the dub
   * track (like its export-time counterpart) tracks the flattened output
   * position, not the source file's own time across a cut. */
  dubPreviewFile?: File | null;
  /** Fired on every change to which of the three real sources is currently
   * loaded/playing and how far into it — `Timeline.tsx`'s own playhead has
   * no other way to reflect intro/outro playback (their position lives
   * entirely locally in this component; see `Phase`'s own doc comment).
   * Fires as often as `onPlayheadChange` does during main playback (i.e.
   * on every `timeupdate`/image-clock tick), not just on phase transitions —
   * consumers that only care about transitions should diff it themselves. */
  onPhaseChange?: (phase: Phase, elapsed: number) => void;
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
export type Phase = 'intro' | 'main' | 'outro';

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
    subtitleTracks = [],
    subtitleVttTextByFile = {},
    chapters = [],
    dubPreviewFile = null,
    onPhaseChange,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const currentIndexRef = useRef(0);

  const [phase, setPhase] = useState<Phase>('intro');
  // Mirrors `phase` synchronously (see `setPhaseSynced`) — `switchToMain`
  // can call `video.play()` in the same tick it requests the phase change,
  // firing the native `play` event (and this component's `onPlay` handler)
  // before React has re-rendered and attached a handler closure that's
  // actually seen the new `phase` state. The dub-audio play/pause sync
  // below needs the *current* phase at that exact moment, not a stale one.
  const phaseRef = useRef<Phase>('intro');
  function setPhaseSynced(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }
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

  useEffect(() => {
    onPhaseChange?.(phase, phaseElapsed);
    // `onPhaseChange` deliberately left out — an inline callback from the
    // parent would be a new function identity every render, and re-running
    // this on every parent re-render (rather than only on a genuine
    // phase/elapsed change) would defeat the point of tracking them as
    // deps at all; it still always calls the *current* render's callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, phaseElapsed]);

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

  // Blob URLs for the live `<track>` elements below — rebuilt whenever the
  // track list or any track's own VTT text changes (e.g. a cue edit saved
  // in CaptionLane), same one-URL-per-effect-run pattern as intro/outro's
  // own `introUrlRef`/`outroUrlRef` above.
  const [subtitleUrls, setSubtitleUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const urls: Record<string, string> = {};
    for (const track of subtitleTracks) {
      const vtt = subtitleVttTextByFile[track.fileName];
      if (vtt) urls[track.fileName] = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    }
    setSubtitleUrls(urls);
    return () => {
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [subtitleTracks, subtitleVttTextByFile]);

  // A freshly (re)loaded cue list doesn't retroactively apply to a video
  // that's sitting still — browsers only recompute which cue is active on
  // playback progress or a real seek (their own "time marches on" step), so
  // a track attached while paused would otherwise render nothing until the
  // next scrub or play. Polls (bounded) for the new track's cues to finish
  // their own async load, then forces a same-value `currentTime`
  // reassignment — still a real seek even though the value is unchanged,
  // which does force that recomputation (confirmed empirically, not just
  // per spec).
  useEffect(() => {
    if (Object.keys(subtitleUrls).length === 0) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let attempts = 0;
    const tryNudge = () => {
      if (cancelled) return;
      const loaded = Array.from(video.textTracks).some((t) => (t.cues?.length ?? 0) > 0);
      if (loaded) {
        // eslint-disable-next-line no-self-assign -- deliberate: this still runs a real seek (see comment above), not a no-op.
        video.currentTime = video.currentTime;
        return;
      }
      if (attempts++ < 30) requestAnimationFrame(tryNudge);
    };
    requestAnimationFrame(tryNudge);
    return () => {
      cancelled = true;
    };
  }, [subtitleUrls]);

  // Blob URL for the secondary `<audio>` element below — same
  // one-URL-per-effect-run pattern as the other sources in this file.
  const [dubPreviewUrl, setDubPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!dubPreviewFile) {
      setDubPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(dubPreviewFile);
    setDubPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [dubPreviewFile]);

  // The main video is muted for as long as a dub preview is active, so the
  // viewer hears the dub track instead of the original rather than both
  // layered — restored the moment preview selection clears.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = !!dubPreviewUrl;
    if (!dubPreviewUrl) audioRef.current?.pause();
  }, [dubPreviewUrl]);

  // A freshly selected dub track needs its own starting position — it has
  // no `timeupdate`/`seeked` history with the rest of this component yet,
  // so once its metadata is ready (immediately, if it already is), seek it
  // to the current playhead and match whatever the main video is already
  // doing.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !dubPreviewUrl) return;
    const sync = () => {
      audio.currentTime = playheadTime;
      if (isPlaying && phaseRef.current === 'main') void audio.play().catch(() => {});
    };
    if (audio.readyState >= 1) {
      sync();
      return;
    }
    audio.addEventListener('loadedmetadata', sync, { once: true });
    return () => audio.removeEventListener('loadedmetadata', sync);
    // Only re-run on a genuine track swap, not on every playheadTime/
    // isPlaying tick — those are handled by the resync and play/pause-sync
    // effects below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dubPreviewUrl]);

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
    setPhaseSynced('intro');
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
    setPhaseSynced('main');
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
    setPhaseSynced('outro');
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
    if (video && segments.length > 0) {
      const loc = locateGlobalTime(segments, playheadTime);
      if (loc) {
        currentIndexRef.current = loc.index;
        // Tolerance distinguishes "someone moved the playhead" from "the
        // video is just playing forward and timeupdate is echoing its own
        // position".
        if (Math.abs(video.currentTime - loc.localSourceTime) > 0.35) {
          video.currentTime = loc.localSourceTime;
        }
      }
    }
    // The dub track has no segments/cuts of its own — it tracks the
    // flattened `playheadTime` directly, the same tolerance-based resync
    // rather than frame-accurate sample sync (see the prop's own doc
    // comment).
    const audio = audioRef.current;
    if (audio && dubPreviewUrl && Math.abs(audio.currentTime - playheadTime) > 0.35) {
      audio.currentTime = playheadTime;
    }
  }, [playheadTime, segments, phase, dubPreviewUrl]);

  // Dub content only ever covers the main clip — pause it the instant we
  // leave that phase (switching to an outro, or running out of content).
  useEffect(() => {
    if (phase !== 'main') audioRef.current?.pause();
  }, [phase]);

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

  // The last chapter marker at or before the playhead — empty string (no
  // label rendered) outside the main phase or before the first marker.
  const currentChapterTitle =
    phase === 'main' ? [...chapters].reverse().find((c) => c.time <= playheadTime)?.title ?? '' : '';

  return (
    <div className="preview-pane">
      <div className="preview-frame">
        <video
          ref={videoRef}
          playsInline
          style={activeImageClip ? { visibility: 'hidden' } : undefined}
          onPlay={() => {
            setIsPlaying(true);
            if (dubPreviewUrl && phaseRef.current === 'main') void audioRef.current?.play().catch(() => {});
          }}
          onPause={() => {
            setIsPlaying(false);
            audioRef.current?.pause();
          }}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
        >
          {phase === 'main' &&
            subtitleTracks.map((track, i) => {
              const url = subtitleUrls[track.fileName];
              if (!url) return null;
              return <track key={track.fileName} kind="subtitles" src={url} srcLang={track.language} label={track.label} default={i === 0} />;
            })}
        </video>
        {activeImageClip && activeImageUrl && <img className="preview-still" src={activeImageUrl} alt="" />}
        {/* No visible UI of its own — a secondary audio source kept in lockstep
            with the main video for as long as a dub track is selected for
            preview (see the play/pause sync above and the resync effect). */}
        <audio ref={audioRef} className="dub-preview-audio" src={dubPreviewUrl ?? undefined} style={{ display: 'none' }} />
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

        {currentChapterTitle && <span className="preview-chapter-label">{currentChapterTitle}</span>}

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
