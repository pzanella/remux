import { useEffect, useRef } from 'react';

interface WaveformProps {
  peaks: number[];
  /** A CSS custom property *name* (e.g. "--accent"), not a `var(...)`
   * expression — Canvas 2D's fillStyle doesn't resolve custom properties on
   * its own (it's not part of the DOM style cascade the way element styles
   * are), so this gets resolved to a real color via getComputedStyle
   * right before drawing instead. */
  colorVar: string;
}

/** Draws pre-computed peaks as vertical bars — a canvas rather than one DOM
 * node per bar, since a clip can easily need a hundred+ of them. */
export default function Waveform({ peaks, colorVar }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (peaks.length === 0) return;

    const resolvedColor = getComputedStyle(canvas).getPropertyValue(colorVar).trim() || '#e8a33d';
    ctx.fillStyle = resolvedColor;
    const barWidth = width / peaks.length;
    const mid = height / 2;
    for (let i = 0; i < peaks.length; i++) {
      const barHeight = Math.max(1, peaks[i] * height);
      ctx.fillRect(i * barWidth, mid - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
    }
  }, [peaks, colorVar]);

  return <canvas ref={canvasRef} className="waveform-canvas" />;
}
