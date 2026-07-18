import type { TranscodingSession } from '../types';

interface ResumeBannerProps {
  session: TranscodingSession;
  canResume: boolean;
  onResume: () => void;
  onDismiss: () => void;
}

export default function ResumeBanner({ session, canResume, onResume, onDismiss }: ResumeBannerProps) {
  return (
    <div className="banner">
      <div>
        <p>Looks like a conversion was interrupted.</p>
        <p className="panel-hint">
          {session.sourceFileName} — {session.lastSegmentIndex + 1}/{session.totalSegments} parts done
        </p>
      </div>
      <div className="btn-row">
        <button onClick={onResume} disabled={!canResume} className="btn btn-primary">
          Resume
        </button>
        <button onClick={onDismiss} className="btn">
          Dismiss
        </button>
      </div>
    </div>
  );
}
