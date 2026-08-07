import { ABR_LADDER } from '../types';

interface RenditionChipsProps {
  heights: number[];
  sourceResolution: { width: number; height: number } | null;
  disabled: boolean;
  onToggleHeight: (height: number) => void;
}

/** Which adaptive renditions to generate — a row of toggle chips rather
 * than a checkbox list, per the studio layout's "row of rendition toggle
 * chips" under the preview. Selecting any chip is what turns adaptive HLS
 * on at all (see the `abrEnabled` sync effect in App.tsx); selecting none
 * exports the single fast-path quality instead. Anything above the
 * source's own resolution is disabled — generating it would only upscale. */
export default function RenditionChips({ heights, sourceResolution, disabled, onToggleHeight }: RenditionChipsProps) {
  return (
    <div className="rendition-chips">
      {ABR_LADDER.map((r) => {
        const tooLarge = !!sourceResolution && r.height > sourceResolution.height;
        const active = heights.includes(r.height);
        return (
          <button
            key={r.height}
            type="button"
            className={`chip${active ? ' is-active' : ''}`}
            disabled={disabled || tooLarge}
            onClick={() => onToggleHeight(r.height)}
            title={tooLarge ? `Source is ${sourceResolution!.height}p — ${r.label} would upscale` : `Generate a ${r.label} rendition`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
