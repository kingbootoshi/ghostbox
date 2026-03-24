import type { GhostState } from '../api'

type GhostHeaderProps = {
  ghostName: string | null
  ghost: GhostState | null
  activeView: 'chat' | 'files'
  busyLabel?: string
  hasUnsavedFileChanges?: boolean
  onToggleFiles: () => void
  onToggleStatus: () => void
  onSave: () => void
  onManageKeys: () => void
}

export function GhostHeader({
  ghostName,
  ghost,
  activeView,
  busyLabel,
  hasUnsavedFileChanges,
  onToggleFiles,
  onToggleStatus,
  onSave,
  onManageKeys,
}: GhostHeaderProps) {
  if (!ghost) {
    return (
      <header className="ghost-header panel">
        <div>
          <p className="eyebrow">Ghost details</p>
          <h2 className="ghost-header__title">Select a ghost</h2>
        </div>
      </header>
    )
  }

  const toggleLabel = ghost.status === 'running' ? 'Kill' : 'Wake'
  const busyToggleLabel = ghost.status === 'running' ? 'Killing...' : 'Waking...'

  return (
    <header className="ghost-header panel">
      <div className="ghost-header__info">
        <div>
          <p className="eyebrow">Ghost details</p>
          <h2 className="ghost-header__title">{ghostName}</h2>
        </div>

        <div className="ghost-header__meta">
          <span className="ghost-header__name">
            {ghost.provider}/{ghost.model}
          </span>
          <span className={`status-badge status-badge--${ghost.status}`}>{ghost.status}</span>
        </div>
      </div>

      <div className="ghost-header__identity">
        <p className="ghost-header__ghost-name">{ghost.provider} ghost</p>
        <h3>{ghost.status === 'running' ? 'Live session ready' : 'Ghost is stopped'}</h3>
        <p className="ghost-header__subtext">
          {ghost.systemPrompt || 'No system prompt configured.'}
        </p>
      </div>

      <div className="ghost-header__actions">
        <button
          aria-pressed={activeView === 'files'}
          className={[
            'button',
            activeView === 'files' ? 'button--primary button--tab-active' : 'button--ghost',
          ].join(' ')}
          disabled={Boolean(busyLabel)}
          onClick={onToggleFiles}
          type="button"
        >
          Files
          {hasUnsavedFileChanges ? ' *' : ''}
        </button>
        <button
          className="button button--ghost"
          disabled={Boolean(busyLabel)}
          onClick={onToggleStatus}
          type="button"
        >
          {busyLabel === toggleLabel.toLowerCase() ? busyToggleLabel : toggleLabel}
        </button>
        <button
          className="button button--ghost"
          disabled={Boolean(busyLabel)}
          onClick={onSave}
          type="button"
        >
          {busyLabel === 'save' ? 'Saving...' : 'Save vault'}
        </button>
        <button
          className="button button--primary"
          disabled={Boolean(busyLabel)}
          onClick={onManageKeys}
          type="button"
        >
          Manage keys
        </button>
      </div>
    </header>
  )
}
