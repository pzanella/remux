import Header from './components/Header';
import ResumeBanner from './components/ResumeBanner';
import SourcePanel from './components/SourcePanel';
import OutputPanel from './components/OutputPanel';
import AbrPanel from './components/AbrPanel';
import TransportControls from './components/TransportControls';
import ProgressPanel from './components/ProgressPanel';
import ActivityPanel from './components/ActivityPanel';
import Player from './components/Player';
import { useTranscoder } from './hooks/useTranscoder';

export default function App() {
  const t = useTranscoder();

  return (
    <div className="app-shell">
      <div className="app-inner">
        <Header status={t.status} />

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
            <SourcePanel
              session={t.session}
              status={t.status}
              uploadProgress={t.uploadProgress}
              disabled={t.isRunning}
              onFileSelected={t.selectFile}
            />
            <OutputPanel outputFolder={t.outputFolder} disabled={t.isRunning} onSelectFolder={t.selectOutputFolder} />
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
              onStart={t.start}
              onResume={t.resume}
              onPause={t.pause}
              onCancel={t.cancel}
            />
            <ProgressPanel
              status={t.status}
              convertProgress={t.convertProgress}
              segmentProgress={t.segmentProgress}
              renditionLabel={t.renditionLabel}
            />
          </div>

          <div className="stage">
            <Player m3u8Content={t.m3u8Preview} outputFolderHandle={t.outputFolder} isComplete={t.status === 'complete'} />
            <ActivityPanel
              logs={t.logs}
              onClearLogs={t.clearLogs}
              m3u8={t.masterM3u8Preview || t.m3u8Preview}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
