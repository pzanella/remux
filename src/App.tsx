import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import EmptyState from './components/EmptyState';
import BatchQueue from './components/BatchQueue';
import PreviewPane, { type PreviewPaneHandle } from './components/PreviewPane';
import Timeline from './components/Timeline';
import CaptionLane from './components/CaptionLane';
import ChapterRuler from './components/ChapterRuler';
import MediaExtrasPanel from './components/MediaExtrasPanel';
import ExportModal from './components/ExportModal';
import ResumeBanner from './components/ResumeBanner';
import ToastStack from './components/ToastStack';
import Player from './components/Player';
import { useTranscoder } from './hooks/useTranscoder';
import { useEditorSegments } from './hooks/useEditorSegments';
import { useChapters } from './hooks/useChapters';
import { useBatchTranscoder } from './hooks/useBatchTranscoder';
import { isTrivialEdit } from './lib/segments';

export default function App() {
  const t = useTranscoder();
  const editor = useEditorSegments(t.sourceDuration);
  const chapters = useChapters(t.sourceDuration);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const previewRef = useRef<PreviewPaneHandle>(null);

  // Dub-audio + edited (trimmed/split) segments, and dub-audio + intro/
  // outro, both work now on the fast path (see runSegmentedFastPath's and
  // spliceIntroOutro's own hasDubAudio handling) — the one remaining
  // unsupported combination is either of those *plus* adaptive bitrate
  // (worker-side: runTranscoding's own guard), which is what this warns
  // about before it can only be discovered as a hard export-time error.
  const hasEditedSegments = t.sourceDuration !== undefined && !isTrivialEdit(editor.segments, t.sourceDuration);
  const hasIntroOrOutro = !!(t.introFile || t.outroFile);
  const dubAudioAbrBlockers = [hasEditedSegments && 'a trimmed/split timeline', hasIntroOrOutro && 'an attached intro/outro'].filter(
    (s): s is string => !!s,
  );
  const dubAudioAbrWarning =
    dubAudioAbrBlockers.length > 0 && t.abrEnabled && t.dubAudioTracks.length > 0
      ? `Dub-audio tracks aren't supported together with ${dubAudioAbrBlockers.join(' or ')} on an adaptive-bitrate export yet — switch to a single quality, or remove one of the two.`
      : undefined;

  // PreviewPane's own reset effect keys off these objects' identity (to
  // catch a genuine attach/detach) — a fresh object literal on every render
  // here would refire it on every playhead tick during playback, since
  // `t.introFile`/`t.outroFile` themselves are otherwise reference-stable
  // between renders. Memoized on those, not reconstructed every render.
  const introPreviewClip = useMemo(
    () => (t.introFile ? { file: t.introFile.file, duration: t.introFile.duration ?? 0, isImage: t.introFile.isImage } : null),
    [t.introFile],
  );
  const outroPreviewClip = useMemo(
    () => (t.outroFile ? { file: t.outroFile.file, duration: t.outroFile.duration ?? 0, isImage: t.outroFile.isImage } : null),
    [t.outroFile],
  );

  // Batch mode is a fully separate flow (see useBatchTranscoder's own doc
  // comment) — its own hook instance, never touching `t` at all, swapped in
  // for the whole screen the moment more than one file is dropped/picked.
  const batch = useBatchTranscoder();
  const [isBatchMode, setIsBatchMode] = useState(false);
  const handleSelectFiles = useCallback(
    (files: File[]) => {
      batch.addFiles(files);
      setIsBatchMode(true);
    },
    [batch],
  );
  const handleExitBatch = useCallback(() => {
    batch.clearBatch();
    setIsBatchMode(false);
  }, [batch]);

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
      t.start(
        editor.segments.map(({ sourceStart, sourceEnd }) => ({ sourceStart, sourceEnd })),
        chapters.chapters.map(({ time, title }) => ({ time, title })),
      );
    }
  }, [t, editor.segments, chapters.chapters]);

  const handleReset = useCallback(() => {
    void t.reset();
    setExportModalOpen(false);
  }, [t]);

  const handleSaveProject = useCallback(() => {
    void t.saveProject(
      editor.segments.map(({ sourceStart, sourceEnd }) => ({ sourceStart, sourceEnd })),
      chapters.chapters.map(({ time, title }) => ({ time, title })),
    );
  }, [t, editor.segments, chapters.chapters]);

  // Ingests a `.remuxproj` bundle (see EmptyState's own "Load Project"
  // affordance): `useTranscoder.loadProject` re-hydrates everything it owns
  // itself (source file, intro/outro, dub-audio, subtitles, output
  // settings) and hands back the saved segments/chapters, since those live
  // in the two separate hooks below rather than in `t` — same reason
  // `start`/`saveProject` above take them as parameters instead of owning
  // them.
  const handleLoadProject = useCallback(
    async (file: File) => {
      const result = await t.loadProject(file);
      if (result) {
        editor.loadSegments(result.segments);
        chapters.loadChapters(result.chapters);
      }
    },
    [t, editor, chapters],
  );

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

  if (isBatchMode) {
    return (
      <BatchQueue
        items={batch.items}
        isRunning={batch.isRunning}
        isComplete={batch.isComplete}
        canStart={batch.canStart}
        outputMode={batch.outputMode}
        rootFolder={batch.rootFolder}
        outputContainer={batch.outputContainer}
        loudnessNormalization={batch.loudnessNormalization}
        abrHeights={batch.abrHeights}
        onAddFiles={batch.addFiles}
        onRemoveItem={batch.removeItem}
        onSelectRootFolder={batch.selectRootFolder}
        onSetOutputMode={batch.setOutputMode}
        onSetOutputContainer={batch.setOutputContainer}
        onSetLoudnessNormalization={batch.setLoudnessNormalization}
        onToggleAbrHeight={batch.toggleAbrHeight}
        onStart={() => void batch.start()}
        onCancel={batch.cancelBatch}
        onDownloadItemZip={batch.downloadItemZip}
        onClearBatch={batch.clearBatch}
        onExit={handleExitBatch}
      />
    );
  }

  if (t.status === 'saving-to-opfs') {
    return (
      <div className="app-shell">
        <ToastStack toasts={t.toasts} onDismiss={t.dismissToast} />
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
        <ToastStack toasts={t.toasts} onDismiss={t.dismissToast} />
        {t.resumableSession && (
          <ResumeBanner session={t.resumableSession} canResume={t.canResume} onResume={t.resume} onDismiss={t.dismissResume} />
        )}
        <EmptyState onSelectFile={t.selectFile} onSelectFiles={handleSelectFiles} onLoadProject={handleLoadProject} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ToastStack toasts={t.toasts} onDismiss={t.dismissToast} />
      <TopBar
        hasSource
        status={t.status}
        sourceFileName={t.session?.sourceFileName ?? null}
        sourceResolution={t.sourceResolution}
        sourceDuration={t.sourceDuration}
        sourceFileSize={t.session?.sourceFileSize}
        isSavingProject={t.isZipping}
        onReset={handleReset}
        onExportClick={handleExportClick}
        onSaveProject={handleSaveProject}
      />

      {t.resumableSession && (
        <ResumeBanner session={t.resumableSession} canResume={t.canResume} onResume={t.resume} onDismiss={t.dismissResume} />
      )}

      <div className="editor-layout">
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
              introClip={introPreviewClip}
              outroClip={outroPreviewClip}
              subtitleTracks={t.subtitleTracks}
              subtitleVttTextByFile={t.subtitleVttTextByFile}
              chapters={chapters.chapters}
            />
            <Timeline
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
              introClip={t.introFile ? { label: t.introFile.label, duration: t.introFile.duration, isImage: t.introFile.isImage } : null}
              outroClip={t.outroFile ? { label: t.outroFile.label, duration: t.outroFile.duration, isImage: t.outroFile.isImage } : null}
              onSelectIntroFile={t.selectIntroFile}
              onClearIntroFile={t.clearIntroFile}
              onSetIntroImageDuration={t.setIntroImageDuration}
              onSelectOutroFile={t.selectOutroFile}
              onClearOutroFile={t.clearOutroFile}
              onSetOutroImageDuration={t.setOutroImageDuration}
              introOutroError={t.introOutroError}
              onClearIntroOutroError={t.clearIntroOutroError}
            />
            <MediaExtrasPanel
              dubAudioTracks={t.dubAudioTracks}
              onSelectDubAudioTrack={t.selectDubAudioTrack}
              onRemoveDubAudioTrack={t.removeDubAudioTrack}
              onSetDubAudioTrackLanguage={t.setDubAudioTrackLanguage}
              warning={dubAudioAbrWarning}
              error={t.dubAudioError}
              onClearError={t.clearDubAudioError}
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
            <ChapterRuler
              segments={editor.segments}
              playheadTime={editor.playheadTime}
              onPlayheadChange={editor.setPlayheadTime}
              chapters={chapters.chapters}
              onAddChapterAt={chapters.addChapterAt}
              onRenameChapter={chapters.renameChapter}
              onRemoveChapter={chapters.removeChapter}
            />
          </>
        ) : (
          <div className="preview-pane">
            <Player
              m3u8Content={t.masterM3u8Preview || t.m3u8Preview}
              outputFolderHandle={t.outputFolder}
              isComplete={t.status === 'complete'}
              dashManifestFilename={t.outputContainer === 'fmp4' ? 'manifest.mpd' : undefined}
            />
          </div>
        )}
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
          outputContainer={t.outputContainer}
          loudnessNormalization={t.loudnessNormalization}
          logs={t.logs}
          m3u8={t.masterM3u8Preview || t.m3u8Preview}
          introFile={t.introFile}
          outroFile={t.outroFile}
          subtitleTracks={t.subtitleTracks}
          dubAudioTracks={t.dubAudioTracks}
          chapters={chapters.chapters}
          onClose={() => setExportModalOpen(false)}
          onSelectFolder={t.selectOutputFolder}
          onSetOutputMode={t.setOutputMode}
          onSetOutputContainer={t.setOutputContainer}
          onSetLoudnessNormalization={t.setLoudnessNormalization}
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
