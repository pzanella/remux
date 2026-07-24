import { useState } from 'react';

const DISMISS_KEY = 'remux:value-prop-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export default function ValuePropBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // localStorage may be unavailable (private mode); dismissal just won't persist.
    }
  };

  return (
    <div className="banner">
      <div>
        <p>Your video never leaves this tab.</p>
        <p className="panel-hint">
          No upload, no transcoding server — MP4/MOV are remuxed byte-for-byte by the fast path, and adaptive HLS
          renditions are encoded with your machine's own hardware encoder.
        </p>
      </div>
      <div className="btn-row">
        <button onClick={handleDismiss} className="btn">
          Got it
        </button>
      </div>
    </div>
  );
}
