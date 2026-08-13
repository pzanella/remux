import { useEffect, useRef, useState } from 'react';

interface TrackWarningProps {
  /** Short trigger text, e.g. "⚠ 2" — kept as short as the old bare badge
   * was, since the detail (not the trigger) is where the real message lives
   * now. */
  label: string;
  /** The specific problem(s) with this track — shown in the popup, not
   * truncated the way a native `title` tooltip effectively was. */
  detail: string;
}

/**
 * A small warning badge with an interactive popup — the agnostic
 * replacement for what used to be a bare `.caption-track-warning` span with
 * a native `title` attribute (CaptionLane's dropped-cue count, ChapterRuler's
 * dropped-chapter count; same shape, just duplicated). A native tooltip
 * only shows on hover, with no click affordance and no touch-device
 * equivalent at all — this shows on hover *and* toggles open on click
 * (closing again on an outside click), so the detail is reachable either
 * way.
 */
export default function TrackWarning({ label, detail }: TrackWarningProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutsidePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', onOutsidePointerDown);
  }, [open]);

  return (
    <span ref={rootRef} className={`track-warning${open ? ' track-warning--open' : ''}`}>
      <button
        type="button"
        className="track-warning-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        {label}
      </button>
      <span className="track-warning-popup" role="tooltip">
        {detail}
      </span>
    </span>
  );
}
