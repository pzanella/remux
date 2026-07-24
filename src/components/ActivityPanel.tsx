import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../types';

const LEVEL_CLASS: Record<LogEntry['level'], string> = {
  info: '',
  success: 'is-success',
  warn: 'is-warn',
  error: 'is-error',
};

interface ActivityPanelProps {
  logs: LogEntry[];
  onClearLogs: () => void;
  m3u8: string;
}

/** Log console and playlist preview share one panel, switched by tab, to save
 * space — and the whole panel starts collapsed, since it's diagnostic detail
 * rather than something needed to edit or start a conversion. Keeping it shut
 * by default is what lets the editor + timeline fit above the fold. */
export default function ActivityPanel({ logs, onClearLogs, m3u8 }: ActivityPanelProps) {
  const [tab, setTab] = useState<'log' | 'playlist'>('log');
  const [expanded, setExpanded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && tab === 'log') endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, tab, expanded]);

  return (
    <div className="panel panel--activity">
      <div className="tabs">
        <button
          className={`tab-btn ${expanded && tab === 'log' ? 'active' : ''}`}
          onClick={() => {
            setTab('log');
            setExpanded(true);
          }}
        >
          Log
        </button>
        <button
          className={`tab-btn ${expanded && tab === 'playlist' ? 'active' : ''}`}
          onClick={() => {
            setTab('playlist');
            setExpanded(true);
          }}
        >
          Playlist
        </button>
        {expanded && tab === 'log' && logs.length > 0 && (
          <button onClick={onClearLogs} className="btn-quiet">
            Clear
          </button>
        )}
        {expanded && tab === 'playlist' && m3u8 && (
          <button onClick={() => void navigator.clipboard.writeText(m3u8)} className="btn-quiet">
            Copy
          </button>
        )}
        <button
          className="btn-quiet activity-toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded &&
        (tab === 'log' ? (
          <div className="log-console">
            {logs.length === 0 ? (
              <p className="log-empty">Nothing yet.</p>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className={`log-line ${LEVEL_CLASS[entry.level]}`}>
                  <span className="log-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  {entry.message}
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>
        ) : (
          <pre className="playlist-pre">{m3u8 || 'Nothing to show yet — start a conversion first.'}</pre>
        ))}
    </div>
  );
}
