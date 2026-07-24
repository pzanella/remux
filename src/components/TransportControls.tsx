import type { AppStatus } from '../types';

interface TransportControlsProps {
  status: AppStatus;
  isRunning: boolean;
  canStart: boolean;
  canResume: boolean;
  /** Adaptive HLS jobs (either engine) can't pause mid-flight — a restart
   * begins the whole job over — so the button is hidden rather than shown
   * doing nothing. */
  canPause: boolean;
  isZipping: boolean;
  /** Whether there's anything to reset — a file has been picked, even if
   * the job hasn't started or has already finished. */
  hasSession: boolean;
  onStart: () => void;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onDownloadZip: () => void;
  onReset: () => void;
}

export default function TransportControls({
  status,
  isRunning,
  canStart,
  canResume,
  canPause,
  isZipping,
  hasSession,
  onStart,
  onResume,
  onPause,
  onCancel,
  onDownloadZip,
  onReset,
}: TransportControlsProps) {
  return (
    <div className="btn-row">
      <button onClick={onStart} disabled={!canStart} className="btn btn-primary">
        Start
      </button>

      {canResume && (
        <button onClick={onResume} disabled={isRunning} className="btn">
          Resume
        </button>
      )}

      {isRunning && canPause && (
        <button onClick={onPause} className="btn">
          Pause
        </button>
      )}

      {(isRunning || status === 'paused') && (
        <button onClick={onCancel} className="btn btn-danger">
          Cancel
        </button>
      )}

      {status === 'complete' && (
        <button onClick={onDownloadZip} disabled={isZipping} className="btn">
          {isZipping ? 'Zipping…' : 'Download as ZIP'}
        </button>
      )}

      {hasSession && (
        <button onClick={onReset} className="btn-quiet">
          Start over
        </button>
      )}
    </div>
  );
}
