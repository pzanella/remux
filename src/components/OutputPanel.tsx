interface OutputPanelProps {
  outputFolder: FileSystemDirectoryHandle | null;
  outputMode: 'opfs' | 'folder';
  disabled: boolean;
  onSelectFolder: () => void;
  onSetOutputMode: (mode: 'opfs' | 'folder') => void;
}

export default function OutputPanel({ outputFolder, outputMode, disabled, onSelectFolder, onSetOutputMode }: OutputPanelProps) {
  return (
    <div className="panel">
      <span className="section-label">2 · Output</span>
      <div className="checkbox-grid">
        <label className={`checkbox-row${disabled ? ' is-disabled' : ''}`}>
          <input
            type="radio"
            name="output-mode"
            checked={outputMode === 'opfs'}
            disabled={disabled}
            onChange={() => onSetOutputMode('opfs')}
          />
          Browser storage
        </label>
        <label className={`checkbox-row${disabled ? ' is-disabled' : ''}`}>
          <input
            type="radio"
            name="output-mode"
            checked={outputMode === 'folder'}
            disabled={disabled}
            onChange={() => onSetOutputMode('folder')}
          />
          Local folder
        </label>
      </div>

      {outputMode === 'opfs' ? (
        <p className="panel-hint">No picker, no permission prompt — segments stay in this browser until you download them.</p>
      ) : (
        <>
          <button onClick={onSelectFolder} disabled={disabled} className="btn">
            Choose a folder…
          </button>
          <p className="panel-hint">Segments are saved directly to disk</p>
          {outputFolder && <p className="panel-value">{outputFolder.name}</p>}
        </>
      )}
    </div>
  );
}
