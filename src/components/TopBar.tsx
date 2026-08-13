import { useRef } from 'react';
import type { AppStatus } from '../types';
import { PROJECT_FILE_EXTENSION } from '../lib/projectFile';

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
  status: AppStatus;
  sourceFileName: string | null;
  sourceResolution: { width: number; height: number } | null;
  sourceDuration: number | undefined;
  sourceFileSize: number | undefined;
  isSavingProject: boolean;
  onReset: () => void;
  onExportClick: () => void;
  onSaveProject: () => void;
  /** Re-opens a `.remuxproj` bundle saved earlier via "Save Project" —
   * the same `handleLoadProject` EmptyState's own "Have a saved project?"
   * link already uses, just reachable from here too: that link only ever
   * shows before anything is loaded, so switching to a different saved
   * project mid-session had no direct path short of "Start Over" first and
   * hunting for it. */
  onLoadProject: (file: File) => void;
}

/** Logo/wordmark + current project's identity, and the one primary action
 * (export) — everything else (output destination, renditions, progress)
 * lives inside the export flow it triggers, not cluttering this bar. "Save
 * Project"/"Load Project" are the exception, kept quiet (`.btn-quiet`, not
 * `.btn-primary`) precisely so they don't compete with Export as a second
 * primary action — they're a save/resume checkpoint for work in progress,
 * not something that belongs inside the export review flow itself. */
export default function TopBar({
  hasSource,
  status,
  sourceFileName,
  sourceResolution,
  sourceDuration,
  sourceFileSize,
  isSavingProject,
  onReset,
  onExportClick,
  onSaveProject,
  onLoadProject,
}: TopBarProps) {
  const isComplete = status === 'complete';
  const projectInputRef = useRef<HTMLInputElement>(null);
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

      <button
        type="button"
        className="btn-quiet"
        onClick={() => projectInputRef.current?.click()}
        title={`Open a previously saved project (${PROJECT_FILE_EXTENSION})`}
      >
        Load Project
      </button>
      <input
        ref={projectInputRef}
        type="file"
        accept={PROJECT_FILE_EXTENSION}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onLoadProject(file);
          e.target.value = '';
        }}
      />

      {hasSource && (
        <button type="button" className="btn-quiet" onClick={onSaveProject} disabled={isSavingProject} title="Download this project (source + edits) to resume later or share it">
          {isSavingProject ? 'Saving…' : 'Save Project'}
        </button>
      )}

      <button
        type="button"
        className="btn-primary btn-export"
        onClick={onExportClick}
        disabled={!hasSource}
        title={isComplete ? 'Your export is ready — open it to download the ZIP' : 'Review output settings and start an export'}
      >
        {isComplete ? 'Download ZIP' : 'Export HLS'}
      </button>
    </header>
  );
}
