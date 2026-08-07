import { useRef, useState } from 'react';
import { SUPPORTED_VIDEO_MIME_TYPES } from '../types';

const FORMAT_CHIPS = ['MP4', 'MOV', 'MKV', 'WebM', 'AVI', 'WMV', 'FLV'];

interface EmptyStateProps {
  onSelectFile: (file: File) => void;
}

/** Full-height centered dropzone shown before anything is loaded — the
 * editor and its top bar don't render at all yet, so this is the entire
 * page. */
export default function EmptyState({ onSelectFile }: EmptyStateProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsOver(true);
  };
  const onDragLeave = () => setIsOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onSelectFile(file);
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onSelectFile(file);
    e.target.value = '';
  };

  return (
    <div className="empty-state">
      <button
        type="button"
        className={`dropzone${isOver ? ' is-drag-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="brand-mark brand-mark--lg" aria-hidden="true" />
        <span className="dropzone-title">Drop a video, or click to browse</span>
        <span className="dropzone-hint">Trim, split, and reorder it, then export as adaptive HLS</span>
        <div className="format-chip-row">
          {FORMAT_CHIPS.map((f) => (
            <span key={f} className="format-chip">
              {f}
            </span>
          ))}
        </div>
        <span className="dropzone-privacy">Processed entirely in your browser — nothing is uploaded.</span>
      </button>
      <input ref={inputRef} type="file" accept={SUPPORTED_VIDEO_MIME_TYPES} className="sr-only" onChange={onPick} />
    </div>
  );
}
