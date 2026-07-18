import { ABR_LADDER } from '../types';

interface AbrPanelProps {
  disabled: boolean;
  enabled: boolean;
  heights: number[];
  sourceResolution: { width: number; height: number } | null;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleHeight: (height: number) => void;
}

/** Optional multi-resolution (ABR) HLS output — re-encodes instead of using the fast remux path above. */
export default function AbrPanel({
  disabled,
  enabled,
  heights,
  sourceResolution,
  onToggleEnabled,
  onToggleHeight,
}: AbrPanelProps) {
  return (
    <div className="panel">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onToggleEnabled(e.target.checked)}
        />
        <span className="section-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Adaptive HLS (multi-resolution)
        </span>
      </label>

      {enabled && (
        <>
          <p className="panel-hint">
            Re-encodes the video (unlike the fast path above) using your GPU when possible, falling back to a
            slower software encoder if not.
          </p>
          <div className="checkbox-grid">
            {ABR_LADDER.map((r) => {
              const tooLarge = !!sourceResolution && r.height > sourceResolution.height;
              return (
                <label key={r.height} className={`checkbox-row ${tooLarge ? 'is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={heights.includes(r.height)}
                    disabled={disabled || tooLarge}
                    onChange={() => onToggleHeight(r.height)}
                  />
                  {r.label}
                </label>
              );
            })}
          </div>
          {sourceResolution && (
            <p className="panel-hint">
              Source is {sourceResolution.width}×{sourceResolution.height} — larger renditions are disabled to avoid upscaling.
            </p>
          )}
        </>
      )}
    </div>
  );
}
