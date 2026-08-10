function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

interface TopBarProps {
  hasSource: boolean;
  sourceFileName: string | null;
  sourceResolution: { width: number; height: number } | null;
  sourceDuration: number | undefined;
  sourceFileSize: number | undefined;
  isSavingProject: boolean;
  onReset: () => void;
  onExportClick: () => void;
  onSaveProject: () => void;
}

/** Logo/wordmark + current project's identity, and the one primary action
 * (export) — everything else (output destination, renditions, progress)
 * lives inside the export flow it triggers, not cluttering this bar. "Save
 * Project" is the one exception, kept quiet (`.btn-quiet`, not
 * `.btn-primary`) precisely so it doesn't compete with Export as a second
 * primary action — it's a save/share checkpoint for work in progress, not
 * something that belongs inside the export review flow itself. */
export default function TopBar({
  hasSource,
  sourceFileName,
  sourceResolution,
  sourceDuration,
  sourceFileSize,
  isSavingProject,
  onReset,
  onExportClick,
  onSaveProject,
}: TopBarProps) {
  return (
    <header className="topbar">
      <button type="button" className="topbar-brand" onClick={onReset} title="Start over">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">remux</span>
      </button>

      {hasSource && (
        <div className="topbar-meta">
          <span className="topbar-filename">{sourceFileName}</span>
          {sourceResolution && (
            <span className="topbar-meta-item">
              {sourceResolution.width}×{sourceResolution.height}
            </span>
          )}
          {sourceDuration !== undefined && <span className="topbar-meta-item">{formatDuration(sourceDuration)}</span>}
          {sourceFileSize !== undefined && <span className="topbar-meta-item">{formatBytes(sourceFileSize)}</span>}
        </div>
      )}

      <div className="topbar-spacer" />

      {hasSource && (
        <button type="button" className="btn-quiet" onClick={onSaveProject} disabled={isSavingProject} title="Download this project (source + edits) to resume later or share it">
          {isSavingProject ? 'Saving…' : 'Save Project'}
        </button>
      )}

      <button type="button" className="btn-primary btn-export" onClick={onExportClick} disabled={!hasSource}>
        Export HLS
      </button>
    </header>
  );
}
