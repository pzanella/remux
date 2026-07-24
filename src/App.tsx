import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header';
import ValuePropBanner from './components/ValuePropBanner';
import ResumeBanner from './components/ResumeBanner';
import OutputPanel from './components/OutputPanel';
import AbrPanel from './components/AbrPanel';
import TransportControls from './components/TransportControls';
import ProgressPanel from './components/ProgressPanel';
import ActivityPanel from './components/ActivityPanel';
import Player from './components/Player';
import RawPreview, { type RawPreviewHandle, type SeekCommand } from './components/RawPreview';
import Timeline, { type ClipKind } from './components/Timeline';
import { useTranscoder } from './hooks/useTranscoder';

export default function App() {
  const t = useTranscoder();
  const [selectedClip, setSelectedClip] = useState<ClipKind | null>(null);
  const [scrubTarget, setScrubTarget] = useState<SeekCommand | null>(null);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [previewMuted, setPreviewMuted] = useState(false);
  const rawPreviewRef = useRef<RawPreviewHandle>(null);

  // Before a conversion has started, the preview shows the raw clip the
  // user has selected on the timeline — there's no HLS output yet to hand
  // to the Shaka player. Once Start is pressed, Player takes over and
  // shows the real (converting or finished) result instead.
  const editingPhase = t.status === 'idle' || t.status === 'saving-to-opfs';

  const hasOutro = !!t.outroFile;
  const introDurationForPlayhead = t.introFile?.duration ?? 0;
  const mainDurationForPlayhead = t.sourceDuration ?? 0;

  // Dragging the ruler jumps straight to that point (and switches which
  // clip is shown); playing a clip normally keeps the playhead in sync by
  // converting its own local currentTime back into timeline-global time.
  const handleScrub = useCallback((clip: ClipKind, time: number) => {
    setSelectedClip(clip);
    setScrubTarget({ clip, time, nonce: Date.now() + Math.random() });
    const offset = clip === 'main' ? introDurationForPlayhead : clip === 'outro' ? introDurationForPlayhead + mainDurationForPlayhead : 0;
    setPlayheadTime(offset + time);
  }, [introDurationForPlayhead, mainDurationForPlayhead]);

  const handlePreviewTimeUpdate = useCallback((localTime: number) => {
    const offset =
      selectedClip === 'main' ? introDurationForPlayhead : selectedClip === 'outro' ? introDurationForPlayhead + mainDurationForPlayhead : 0;
    setPlayheadTime(offset + localTime);
  }, [selectedClip, introDurationForPlayhead, mainDurationForPlayhead]);

  // Timeline edits should show up in playback, not just in the track
  // widths: reaching the end of one clip jumps straight into the next one
  // (intro → main → outro) instead of just stopping, so pressing play once
  // at 0:00 plays the whole edit through.
  const handlePreviewEnded = useCallback(() => {
    const current = selectedClip ?? 'main';
    const next: ClipKind | null = current === 'intro' ? 'main' : current === 'main' && hasOutro ? 'outro' : null;
    if (!next) return;
    setSelectedClip(next);
    setScrubTarget({ clip: next, time: 0, nonce: Date.now() + Math.random(), autoplay: true });
    const offset = next === 'main' ? introDurationForPlayhead : introDurationForPlayhead + mainDurationForPlayhead;
    setPlayheadTime(offset);
  }, [selectedClip, hasOutro, introDurationForPlayhead, mainDurationForPlayhead]);

  // Spacebar toggles play/pause on the active preview clip, same as most
  // video editors — guarded so it doesn't hijack typing in the subtitle
  // cue editor or any other text field.
  useEffect(() => {
    if (!editingPhase) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      rawPreviewRef.current?.togglePlayPause();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingPhase]);

  return (
    <div className="app-shell">
      <div className="app-inner">
        <Header status={t.status} />
        <ValuePropBanner />

        {t.resumableSession && (
          <ResumeBanner
            session={t.resumableSession}
            canResume={t.canResume}
            onResume={t.resume}
            onDismiss={t.dismissResume}
          />
        )}

        <div className="app-body">
          <div className="rail">
            <OutputPanel
              outputFolder={t.outputFolder}
              outputMode={t.outputMode}
              disabled={t.isRunning}
              onSelectFolder={t.selectOutputFolder}
              onSetOutputMode={t.setOutputMode}
            />
            <AbrPanel
              disabled={t.isRunning}
              enabled={t.abrEnabled}
              heights={t.abrHeights}
              sourceResolution={t.sourceResolution}
              onToggleEnabled={t.setAbrEnabled}
              onToggleHeight={t.toggleAbrHeight}
            />
            <TransportControls
              status={t.status}
              isRunning={t.isRunning}
              canStart={t.canStart}
              canResume={t.canResume}
              canPause={!(t.abrEnabled && t.abrHeights.length > 0)}
              isZipping={t.isZipping}
              hasSession={!!t.session}
              onStart={t.start}
              onResume={t.resume}
              onPause={t.pause}
              onCancel={t.cancel}
              onDownloadZip={t.downloadZip}
              onReset={t.reset}
            />
            <ProgressPanel
              status={t.status}
              convertProgress={t.convertProgress}
              segmentProgress={t.segmentProgress}
              renditionLabel={t.renditionLabel}
            />
          </div>

          <div className="stage">
            {editingPhase ? (
              <RawPreview
                ref={rawPreviewRef}
                selectedClip={selectedClip}
                sourceFile={t.sourceFile}
                introFile={t.introFile?.file ?? null}
                outroFile={t.outroFile?.file ?? null}
                seek={scrubTarget}
                muted={previewMuted}
                onTimeUpdate={handlePreviewTimeUpdate}
                onEnded={handlePreviewEnded}
              />
            ) : (
              <Player
                m3u8Content={t.masterM3u8Preview || t.m3u8Preview}
                outputFolderHandle={t.outputFolder}
                isComplete={t.status === 'complete'}
              />
            )}
          </div>
        </div>

        <Timeline
          disabled={t.isRunning}
          sourceFile={t.sourceFile}
          sourceLabel={t.session?.sourceFileName ?? null}
          sourceDuration={t.sourceDuration}
          introFile={t.introFile}
          outroFile={t.outroFile}
          subtitleTrack={t.subtitleTrack}
          subtitleVttText={t.subtitleVttText}
          selectedClip={selectedClip}
          playheadTime={playheadTime}
          muted={previewMuted}
          onToggleMute={() => setPreviewMuted((m) => !m)}
          onSelectClip={setSelectedClip}
          onScrub={handleScrub}
          onSelectMainFile={t.selectFile}
          onSelectIntro={t.selectIntroFile}
          onClearIntro={t.clearIntroFile}
          onSelectOutro={t.selectOutroFile}
          onClearOutro={t.clearOutroFile}
          onSelectSubtitle={t.selectSubtitleFile}
          onClearSubtitle={t.clearSubtitleTrack}
          onSaveSubtitleEdits={t.saveSubtitleEdits}
          onSubtitleLanguageChange={t.setSubtitleLanguage}
        />

        <ActivityPanel
          logs={t.logs}
          onClearLogs={t.clearLogs}
          m3u8={t.masterM3u8Preview || t.m3u8Preview}
        />
      </div>
    </div>
  );
}
