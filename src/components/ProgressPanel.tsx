import type { AppStatus } from '../types';

interface ProgressPanelProps {
  status: AppStatus;
  convertProgress: number;
  segmentProgress: { done: number; total: number };
  renditionLabel?: string;
}

export default function ProgressPanel({ status, convertProgress, segmentProgress, renditionLabel }: ProgressPanelProps) {
  const pct = segmentProgress.total > 0 ? Math.round((segmentProgress.done / segmentProgress.total) * 100) : 0;

  return (
    <>
      {status === 'converting' && (
        <div className="section">
          <div className="panel-row panel-row--split">
            <span className="panel-hint">
              {renditionLabel ? `Encoding ${renditionLabel}…` : 'Converting to a format Remux can read'}
            </span>
            <span className="panel-hint">{convertProgress}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${convertProgress}%` }} />
          </div>
        </div>
      )}

      {segmentProgress.total > 0 && (
        <div className="section">
          <div className="panel-row panel-row--split">
            <span className="panel-hint">Segments</span>
            <span className="panel-hint">
              {segmentProgress.done} / {segmentProgress.total} ({pct}%)
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </>
  );
}
