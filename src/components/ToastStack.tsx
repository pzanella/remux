interface Toast {
  id: number;
  message: string;
}

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

/** App-wide error surface — mounted once in App.tsx, always visible
 * regardless of what's open, so a failure during editing (uploading,
 * attaching intro/outro/dub-audio/subtitles, saving/loading a project, ...)
 * is never only discoverable by opening the export review screen and
 * finding its own Log tab. Fed by `useTranscoder`'s `addLog`, which pushes
 * here automatically for every `level: 'error'` call — no per-call-site
 * wiring needed. Persists until dismissed rather than auto-expiring: a
 * toast that vanishes before it's read is its own flavor of the same
 * silent-failure problem this exists to fix. */
export default function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="alert" aria-live="assertive">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span className="toast-message">{toast.message}</span>
          <button type="button" className="toast-dismiss" onClick={() => onDismiss(toast.id)} title="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
