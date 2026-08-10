import { ABR_LADDER } from '../types';
import type { BatchQueueItem } from '../hooks/useBatchTranscoder';

interface BatchQueueProps {
  items: BatchQueueItem[];
  isRunning: boolean;
  isComplete: boolean;
  canStart: boolean;
  outputMode: 'opfs' | 'folder';
  rootFolder: FileSystemDirectoryHandle | null;
  outputContainer: 'ts' | 'fmp4';
  loudnessNormalization: boolean;
  abrHeights: number[];
  onAddFiles: (files: File[]) => void;
  onRemoveItem: (id: string) => void;
  onSelectRootFolder: () => void;
  onSetOutputMode: (mode: 'opfs' | 'folder') => void;
  onSetOutputContainer: (container: 'ts' | 'fmp4') => void;
  onSetLoudnessNormalization: (enabled: boolean) => void;
  onToggleAbrHeight: (height: number) => void;
  onStart: () => void;
  onCancel: () => void;
  onDownloadItemZip: (id: string) => void;
  onClearBatch: () => void;
  onExit: () => void;
}

const STATUS_LABEL: Record<BatchQueueItem['status'], string> = {
  pending: 'Queued',
  saving: 'Reading…',
  processing: 'Converting…',
  converting: 'Converting…',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

function itemProgressPct(item: BatchQueueItem): number {
  if (item.status === 'complete') return 100;
  if (item.status === 'converting') return item.convertProgress;
  if (item.segmentProgress.total > 0) return Math.round((item.segmentProgress.done / item.segmentProgress.total) * 100);
  return 0;
}

/** Batch mode's whole screen — replaces the single-file editor entirely
 * (no timeline, no per-file extras) for as long as more than one file was
 * dropped/picked at once. One shared settings pass (output container,
 * loudness normalization, ABR renditions) applies to every queued file;
 * see useBatchTranscoder's own doc comment for why this is a separate flow
 * rather than an extension of the single-file one. */
export default function BatchQueue({
  items,
  isRunning,
  isComplete,
  canStart,
  outputMode,
  rootFolder,
  outputContainer,
  loudnessNormalization,
  abrHeights,
  onAddFiles,
  onRemoveItem,
  onSelectRootFolder,
  onSetOutputMode,
  onSetOutputContainer,
  onSetLoudnessNormalization,
  onToggleAbrHeight,
  onStart,
  onCancel,
  onDownloadItemZip,
  onClearBatch,
  onExit,
}: BatchQueueProps) {
  const doneCount = items.filter((it) => it.status === 'complete').length;
  const errorCount = items.filter((it) => it.status === 'error').length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">remux</span>
        </span>
        <div className="topbar-meta">
          <span className="topbar-filename">
            Batch — {items.length} file{items.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="topbar-spacer" />
        <button type="button" className="btn" onClick={onExit} disabled={isRunning}>
          Back to single file
        </button>
      </header>

      <div className="batch-layout">
        <div className="panel">
          <span className="section-label">Settings — applied to every file</span>

          <div className="checkbox-grid">
            <label className={`checkbox-row${isRunning ? ' is-disabled' : ''}`}>
              <input type="radio" name="batch-output-mode" checked={outputMode === 'opfs'} disabled={isRunning} onChange={() => onSetOutputMode('opfs')} />
              Browser storage (ZIP per file)
            </label>
            <label className={`checkbox-row${isRunning ? ' is-disabled' : ''}`}>
              <input type="radio" name="batch-output-mode" checked={outputMode === 'folder'} disabled={isRunning} onChange={() => onSetOutputMode('folder')} />
              Local folder (one subfolder per file)
            </label>
          </div>
          {outputMode === 'folder' && (
            <>
              <button type="button" className="btn" onClick={onSelectRootFolder} disabled={isRunning}>
                Choose a folder…
              </button>
              {rootFolder && <p className="panel-value">{rootFolder.name}</p>}
            </>
          )}

          <div className="checkbox-grid">
            <label className={`checkbox-row${isRunning ? ' is-disabled' : ''}`}>
              <input type="radio" name="batch-container" checked={outputContainer === 'ts'} disabled={isRunning} onChange={() => onSetOutputContainer('ts')} />
              MPEG-TS
            </label>
            <label className={`checkbox-row${isRunning ? ' is-disabled' : ''}`}>
              <input type="radio" name="batch-container" checked={outputContainer === 'fmp4'} disabled={isRunning} onChange={() => onSetOutputContainer('fmp4')} />
              Fragmented MP4 (experimental)
            </label>
          </div>

          <div className="checkbox-grid">
            <label className={`checkbox-row${isRunning ? ' is-disabled' : ''}`}>
              <input type="checkbox" checked={loudnessNormalization} disabled={isRunning} onChange={(e) => onSetLoudnessNormalization(e.target.checked)} />
              Normalize loudness (EBU R128)
            </label>
          </div>

          <span className="panel-hint">
            Adaptive HLS renditions — skipped per file if it would upscale that file's own resolution
          </span>
          <div className="rendition-chips">
            {ABR_LADDER.map((r) => (
              <button
                key={r.height}
                type="button"
                className={`chip${abrHeights.includes(r.height) ? ' is-active' : ''}`}
                disabled={isRunning}
                onClick={() => onToggleAbrHeight(r.height)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="panel-hint">No trim/split, subtitles, intro/outro, or dub-audio in batch mode — one shared setup, converted as-is.</p>
        </div>

        <div className="panel">
          <div className="panel-row panel-row--split">
            <span className="section-label">Queue</span>
            <label className="btn-quiet" style={{ cursor: isRunning ? 'not-allowed' : 'pointer' }}>
              + Add files
              <input
                type="file"
                accept="video/*"
                multiple
                className="sr-only"
                disabled={isRunning}
                onChange={(e) => {
                  onAddFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {items.length === 0 ? (
            <p className="panel-hint">No files queued yet.</p>
          ) : (
            <div className="batch-list">
              {items.map((item) => (
                <div key={item.id} className={`batch-item batch-item--${item.status}`}>
                  <div className="panel-row panel-row--split">
                    <span className="panel-value">{item.file.name}</span>
                    <span className={`status-line${item.status === 'error' ? ' is-error' : item.status === 'complete' ? ' is-done' : item.status === 'processing' || item.status === 'converting' || item.status === 'saving' ? ' is-active' : ''}`}>
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>
                  {(item.status === 'processing' || item.status === 'converting' || item.status === 'saving') && (
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${itemProgressPct(item)}%` }} />
                    </div>
                  )}
                  {item.status === 'error' && <p className="panel-hint">{item.error}</p>}
                  <div className="btn-row">
                    {item.status === 'complete' && outputMode === 'opfs' && (
                      <button type="button" className="btn" onClick={() => onDownloadItemZip(item.id)} disabled={item.isZipping}>
                        {item.isZipping ? 'Zipping…' : 'Download ZIP'}
                      </button>
                    )}
                    {(item.status === 'pending' || item.status === 'error' || item.status === 'cancelled') && (
                      <button type="button" className="btn-quiet" onClick={() => onRemoveItem(item.id)} disabled={isRunning}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="btn-row">
            {!isRunning && (
              <button type="button" className="btn-primary" onClick={onStart} disabled={!canStart}>
                Start batch
              </button>
            )}
            {isRunning && (
              <button type="button" className="btn btn-danger" onClick={onCancel}>
                Cancel
              </button>
            )}
            {!isRunning && items.length > 0 && (
              <button type="button" className="btn-quiet" onClick={onClearBatch}>
                Clear all
              </button>
            )}
          </div>

          {isComplete && (
            <p className="panel-hint">
              {doneCount} of {items.length} done{errorCount > 0 ? `, ${errorCount} failed` : ''}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
