import { useRef } from 'react';
import type { AppStatus, TranscodingSession } from '../types';
import { SUPPORTED_VIDEO_MIME_TYPES } from '../types';

interface SourcePanelProps {
  session: TranscodingSession | null;
  status: AppStatus;
  uploadProgress: number;
  disabled: boolean;
  onFileSelected: (file: File) => void;
}

export default function SourcePanel({ session, status, uploadProgress, disabled, onFileSelected }: SourcePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
    e.target.value = '';
  };

  return (
    <div className="panel">
      <span className="section-label">1 · Video file</span>
      <button onClick={() => inputRef.current?.click()} disabled={disabled} className="btn">
        Choose a video…
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={SUPPORTED_VIDEO_MIME_TYPES}
        className="sr-only"
        onChange={handleChange}
      />
      <p className="panel-hint">MP4, MOV, MKV, WebM, AVI and a few others</p>

      {status === 'saving-to-opfs' && (
        <div className="section">
          <p className="panel-hint">Saving… {uploadProgress}%</p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {session && status !== 'saving-to-opfs' && <p className="panel-value">{session.sourceFileName}</p>}
    </div>
  );
}
