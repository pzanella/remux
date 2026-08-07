import { useCallback, useEffect, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import EmptyState from './components/EmptyState';
import PreviewPane, { type PreviewPaneHandle } from './components/PreviewPane';
import VerticalTimeline from './components/VerticalTimeline';
import CaptionLane from './components/CaptionLane';
import MediaExtrasPanel from './components/MediaExtrasPanel';
import ExportModal from './components/ExportModal';
import ResumeBanner from './components/ResumeBanner';
import Player from './components/Player';
import { useTranscoder } from './hooks/useTranscoder';
import { useEditorSegments } from './hooks/useEditorSegments';

export default function App() {
  const t = useTranscoder();
  const editor = useEditorSegments(t.sourceDuration);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const previewRef = useRef<PreviewPaneHandle>(null);

  const editingPhase = t.status === 'idle';
  const { abrHeights, setAbrEnabled } = t;

  // A row of rendition chips doubles as adaptive HLS's on/off switch —
  // selecting any of them is what makes it an adaptive job at all, see
  // RenditionChips' own comment.
  useEffect(() => {
    setAbrEnabled(abrHeights.length > 0);
  }, [abrHeights, setAbrEnabled]);

  // Just opens the final review screen (output destination, a recap of
  // whatever's attached, renditions summary) — the job itself only starts
  // once the user presses Start inside it (see handleStartExport), so
  // there's still a moment to pick an output folder before anything runs.
  const handleExportClick = useCallback(() => {
    setExportModalOpen(true);
  }, []);

  const handleStartExport = useCallback(() => {
    if (t.status === 'idle' && t.canStart) {
      t.start(editor.segments.map(({ sourceStart, sourceEnd }) => ({ sourceStart, sourceEnd })));
    }
  }, [t, editor.segments]);

  const handleReset = useCallback(() => {
    void t.reset();
    setExportModalOpen(false);
  }, [t]);

  // Spacebar toggles play/pause on the preview, and Ctrl/Cmd+Z (+ Shift)
  // drives undo/redo — both guarded so they don't hijack typing in a text
  // field, and both only live while there's something to edit.
  useEffect(() => {
    if (!editingPhase) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (e.code === 'Space') {
        e.preventDefault();
        previewRef.current?.togglePlayPause();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingPhase, editor]);

  if (t.status === 'saving-to-opfs') {
    return (
      <div className="app-shell">
        <div className="loading-transition">
          <span className="spinner" aria-hidden="true" />
          <span>Analyzing audio/video streams…</span>
        </div>
      </div>
    );
  }

  if (!t.sourceFile) {
    return (
      <div className="app-shell">
        {t.resumableSession && (
          <ResumeBanner session={t.resumableSession} canResume={t.canResume} onResume={t.resume} onDismiss={t.dismissResume} />
        )}
        <EmptyState onSelectFile={t.selectFile} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        hasSource
        sourceFileName={t.session?.sourceFileName ?? null}
        sourceResolution={t.sourceResolution}
        sourceDuration={t.sourceDuration}
        sourceFileSize={t.session?.sourceFileSize}
        onReset={handleReset}
        onExportClick={handleExportClick}
      />

      {t.resumableSession && (
        <ResumeBanner session={t.resumableSession} canResume={t.canResume} onResume={t.resume} onDismiss={t.dismissResume} />
      )}

      {editingPhase && (
        <MediaExtrasPanel
          introFile={t.introFile}
          outroFile={t.outroFile}
          onSelectIntroFile={t.selectIntroFile}
          onClearIntroFile={t.clearIntroFile}
          onSelectOutroFile={t.selectOutroFile}
          onClearOutroFile={t.clearOutroFile}
          dubAudioTracks={t.dubAudioTracks}
          onSelectDubAudioTrack={t.selectDubAudioTrack}
          onRemoveDubAudioTrack={t.removeDubAudioTrack}
          onSetDubAudioTrackLanguage={t.setDubAudioTrackLanguage}
        />
      )}

      <div className="editor-layout">
        <div className="editor-main">
          {editingPhase ? (
            <>
              <PreviewPane
                ref={previewRef}
                sourceFile={t.sourceFile}
                segments={editor.segments}
                playheadTime={editor.playheadTime}
                onPlayheadChange={editor.setPlayheadTime}
                disabled={!editingPhase}
                abrHeights={t.abrHeights}
                sourceResolution={t.sourceResolution}
                onToggleAbrHeight={t.toggleAbrHeight}
              />
              <CaptionLane
                segments={editor.segments}
                playheadTime={editor.playheadTime}
                onPlayheadChange={editor.setPlayheadTime}
                subtitleTracks={t.subtitleTracks}
                subtitleVttTextByFile={t.subtitleVttTextByFile}
                onSelectSubtitleFile={t.selectSubtitleFile}
                onAddBlankSubtitleTrack={t.addBlankSubtitleTrack}
                onRemoveSubtitleTrack={t.removeSubtitleTrack}
                onSetSubtitleTrackLanguage={t.setSubtitleTrackLanguage}
                onSaveSubtitleEdits={t.saveSubtitleEdits}
              />
            </>
          ) : (
            <div className="preview-pane">
              <Player m3u8Content={t.masterM3u8Preview || t.m3u8Preview} outputFolderHandle={t.outputFolder} isComplete={t.status === 'complete'} />
            </div>
          )}
        </div>

        <VerticalTimeline
          segments={editor.segments}
          selectedId={editor.selectedId}
          playheadTime={editor.playheadTime}
          sourceDuration={t.sourceDuration ?? 0}
          disabled={!editingPhase}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onSelect={editor.setSelectedId}
          onPlayheadChange={editor.setPlayheadTime}
          onSplit={editor.splitAtPlayhead}
          onDelete={editor.remove}
          onReorder={editor.reorder}
          beginGesture={editor.beginGesture}
          previewUpdate={editor.previewUpdate}
          commitGesture={editor.commitGesture}
        />
      </div>

      {exportModalOpen && (
        <ExportModal
          status={t.status}
          isRunning={t.isRunning}
          canResume={t.canResume}
          canPause={!(t.abrEnabled && t.abrHeights.length > 0)}
          isZipping={t.isZipping}
          canStart={t.canStart}
          onStart={handleStartExport}
          convertProgress={t.convertProgress}
          segmentProgress={t.segmentProgress}
          renditionLabel={t.renditionLabel}
          abrHeights={t.abrHeights}
          outputFolder={t.outputFolder}
          outputMode={t.outputMode}
          logs={t.logs}
          m3u8={t.masterM3u8Preview || t.m3u8Preview}
          introFile={t.introFile}
          outroFile={t.outroFile}
          subtitleTracks={t.subtitleTracks}
          dubAudioTracks={t.dubAudioTracks}
          onClose={() => setExportModalOpen(false)}
          onSelectFolder={t.selectOutputFolder}
          onSetOutputMode={t.setOutputMode}
          onResume={t.resume}
          onPause={t.pause}
          onCancel={t.cancel}
          onDownloadZip={t.downloadZip}
          onClearLogs={t.clearLogs}
        />
      )}
    </div>
  );
}
