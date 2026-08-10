import { useRef, useState } from 'react';
import { SUPPORTED_VIDEO_MIME_TYPES } from '../types';

const FORMAT_CHIPS = ['MP4', 'MOV', 'MKV', 'WebM', 'AVI', 'WMV', 'FLV'];

interface EmptyStateProps {
  onSelectFile: (file: File) => void;
  /** A drop/pick with more than one file routes into batch mode (see
   * App.tsx) instead of the single-file editor — no timeline, no per-file
   * extras, just one shared settings pass over every file. `onSelectFile`
   * above still handles the single-file case unchanged. */
  onSelectFiles: (files: File[]) => void;
}

/** Full-height centered dropzone shown before anything is loaded — the
 * editor and its top bar don't render at all yet, so this is the entire
 * page. */
export default function EmptyState({ onSelectFile, onSelectFiles }: EmptyStateProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);

  const dispatch = (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) onSelectFile(files[0]);
    else onSelectFiles(files);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsOver(true);
  };
  const onDragLeave = () => setIsOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsOver(false);
    dispatch(Array.from(e.dataTransfer.files ?? []));
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch(Array.from(e.target.files ?? []));
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
        <span className="dropzone-hint">Drop more than one file to batch-convert them with one shared setup</span>
        <div className="format-chip-row">
          {FORMAT_CHIPS.map((f) => (
            <span key={f} className="format-chip">
              {f}
            </span>
          ))}
        </div>
        <span className="dropzone-privacy">Processed entirely in your browser — nothing is uploaded.</span>
      </button>
      <input ref={inputRef} type="file" accept={SUPPORTED_VIDEO_MIME_TYPES} multiple className="sr-only" onChange={onPick} />
    </div>
  );
}
