import type { AppStatus } from '../types';

const STATUS_LABEL: Record<AppStatus, string> = {
  idle: 'Idle',
  'saving-to-opfs': 'Saving file…',
  converting: 'Converting…',
  processing: 'Working…',
  paused: 'Paused',
  complete: 'Done',
  error: 'Error',
};

const STATUS_CLASS: Record<AppStatus, string> = {
  idle: '',
  'saving-to-opfs': 'is-active',
  converting: 'is-active',
  processing: 'is-active',
  paused: 'is-active',
  complete: 'is-done',
  error: 'is-error',
};

export default function Header({ status }: { status: AppStatus }) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Remux</span>
        <span className="brand-tagline">video to HLS, right in your browser</span>
      </div>
      <span className={`status-line ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
    </header>
  );
}
