interface OutputPanelProps {
  outputFolder: FileSystemDirectoryHandle | null;
  disabled: boolean;
  onSelectFolder: () => void;
}

export default function OutputPanel({ outputFolder, disabled, onSelectFolder }: OutputPanelProps) {
  return (
    <div className="panel">
      <span className="section-label">2 · Output folder</span>
      <button onClick={onSelectFolder} disabled={disabled} className="btn">
        Choose a folder…
      </button>
      <p className="panel-hint">Segments are saved directly to disk</p>
      {outputFolder && <p className="panel-value">{outputFolder.name}</p>}
    </div>
  );
}
