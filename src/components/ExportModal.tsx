import type { AppStatus, LogEntry } from '../types';
import ProgressPanel from './ProgressPanel';
import OutputPanel from './OutputPanel';
import ActivityPanel from './ActivityPanel';
import type { ClipFile } from '../hooks/useTranscoder';

interface ExportModalProps {
  status: AppStatus;
  isRunning: boolean;
  canResume: boolean;
  canPause: boolean;
  isZipping: boolean;
  canStart: boolean;
  convertProgress: number;
  segmentProgress: { done: number; total: number };
  renditionLabel: string;
  abrHeights: number[];
  outputFolder: FileSystemDirectoryHandle | null;
  outputMode: 'opfs' | 'folder';
  logs: LogEntry[];
  m3u8: string;
  introFile: ClipFile | null;
  outroFile: ClipFile | null;
  subtitleTracks: { fileName: string; label: string; language: string }[];
  dubAudioTracks: { fileName: string; label: string; language: string }[];
  onClose: () => void;
  onSelectFolder: () => void;
  onSetOutputMode: (mode: 'opfs' | 'folder') => void;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onDownloadZip: () => void;
  onClearLogs: () => void;
  onStart: () => void;
}

/** Export review + progress/completion overlay — opened the moment "Export
 * HLS" is pressed. At `status === 'idle'` this is a final review screen
 * (a read-only recap of whatever's already been attached via the caption
 * lane and the intro/outro-dub-audio strip elsewhere in the editor, plus
 * output destination and the current rendition selection) with its own
 * Start button; the real worker job only begins once that's pressed (see
 * `onStart`/App.tsx), not just from opening the modal. Subtitles/intro-
 * outro/dub-audio are no longer *attached* from here — see `CaptionLane`
 * and `MediaExtrasPanel`, both persistent in the main editing view — this
 * is just the last stop before a job actually starts. Reusable afterward
 * just to check on a running job again. Progress here is the real worker's
 * own SEGMENT_DONE/CONVERTING events (via ProgressPanel), not a simulated
 * timer. */
export default function ExportModal({
  status,
  isRunning,
  canResume,
  canPause,
  isZipping,
  canStart,
  convertProgress,
  segmentProgress,
  renditionLabel,
  abrHeights,
  outputFolder,
  outputMode,
  logs,
  m3u8,
  introFile,
  outroFile,
  subtitleTracks,
  dubAudioTracks,
  onClose,
  onSelectFolder,
  onSetOutputMode,
  onResume,
  onPause,
  onCancel,
  onDownloadZip,
  onClearLogs,
  onStart,
}: ExportModalProps) {
  const isComplete = status === 'complete';
  const isError = status === 'error';
  const renditionsSummary = abrHeights.length > 0 ? `Adaptive HLS — ${abrHeights.map((h) => `${h}p`).join(', ')}` : 'Single quality (fast remux)';

  const extrasSummary = [
    introFile && 'intro',
    outroFile && 'outro',
    subtitleTracks.length > 0 && `${subtitleTracks.length} subtitle track${subtitleTracks.length > 1 ? 's' : ''}`,
    dubAudioTracks.length > 0 && `${dubAudioTracks.length} dub-audio track${dubAudioTracks.length > 1 ? 's' : ''}`,
  ]
    .filter((s): s is string => !!s)
    .join(', ');

  return (
    <div className="export-modal-backdrop" onClick={onClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <span className="section-label">Export HLS</span>
          <button type="button" className="export-modal-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="export-modal-summary">
          <span className="panel-value">{renditionsSummary}</span>
          {extrasSummary && <span className="panel-hint">Attached: {extrasSummary}</span>}
        </div>

        {status === 'idle' && (
          <OutputPanel outputFolder={outputFolder} outputMode={outputMode} disabled={isRunning} onSelectFolder={onSelectFolder} onSetOutputMode={onSetOutputMode} />
        )}

        <ProgressPanel status={status} convertProgress={convertProgress} segmentProgress={segmentProgress} renditionLabel={renditionLabel} />

        {isComplete && <p className="export-modal-done">Done — your HLS output is ready.</p>}
        {isError && <p className="export-modal-error">Something went wrong — see the log below.</p>}

        <div className="btn-row">
          {status === 'idle' && !canResume && (
            <button type="button" className="btn-primary" onClick={onStart} disabled={!canStart}>
              Start conversion
            </button>
          )}
          {isRunning && canPause && (
            <button type="button" className="btn" onClick={onPause}>
              Pause
            </button>
          )}
          {!isRunning && canResume && !isComplete && (
            <button type="button" className="btn" onClick={onResume}>
              Resume
            </button>
          )}
          {(isRunning || status === 'paused') && (
            <button type="button" className="btn btn-danger" onClick={onCancel}>
              Cancel
            </button>
          )}
          {isComplete && (
            <button type="button" className="btn-primary" onClick={onDownloadZip} disabled={isZipping}>
              {isZipping ? 'Zipping…' : 'Download ZIP'}
            </button>
          )}
        </div>

        <ActivityPanel logs={logs} onClearLogs={onClearLogs} m3u8={m3u8} />
      </div>
    </div>
  );
}
