import { useEffect, useState } from 'react'
import type { GhostState } from '../api'

type SidebarProps = {
  ghosts: Record<string, GhostState>
  loading: boolean
  selectedGhostName: string | null
  theme: 'dark' | 'light'
  actionStates: Record<string, string | undefined>
  onSelectGhost: (name: string) => void
  onToggleTheme: () => void
  onOpenSpawnModal: () => void
  onKillGhost: (name: string) => void
  onWakeGhost: (name: string) => void
  onRemoveGhost: (name: string) => void
  onSaveGhost: (name: string) => void
}

const sortGhostEntries = (ghosts: Record<string, GhostState>) => {
  return Object.entries(ghosts).sort(([leftName], [rightName]) =>
    leftName.localeCompare(rightName),
  )
}

export function Sidebar({
  ghosts,
  loading,
  selectedGhostName,
  theme,
  actionStates,
  onSelectGhost,
  onToggleTheme,
  onOpenSpawnModal,
  onKillGhost,
  onWakeGhost,
  onRemoveGhost,
  onSaveGhost,
}: SidebarProps) {
  const [openMenuGhostName, setOpenMenuGhostName] = useState<string | null>(null)
  const ghostEntries = sortGhostEntries(ghosts)

  useEffect(() => {
    if (!openMenuGhostName) {
      return
    }

    const closeMenu = () => setOpenMenuGhostName(null)
    window.addEventListener('click', closeMenu)

    return () => window.removeEventListener('click', closeMenu)
  }, [openMenuGhostName])

  return (
    <aside className="sidebar panel">
      <div className="sidebar__top">
        <div>
          <p className="eyebrow">Ghostbox</p>
          <h1 className="sidebar__title">Ghosts</h1>
        </div>
        <button className="icon-button" onClick={onOpenSpawnModal} type="button">
          +
        </button>
      </div>

      <div className="sidebar__content">
        {loading ? <p className="sidebar__empty">Loading ghosts...</p> : null}

        {!loading && ghostEntries.length === 0 ? (
          <p className="sidebar__empty">No ghosts yet. Spawn one to start chatting.</p>
        ) : null}

        {ghostEntries.map(([name, ghost]) => {
          const isSelected = selectedGhostName === name
          const isBusy = Boolean(actionStates[name])

          return (
            <div
              key={name}
              className={`ghost-row${isSelected ? ' ghost-row--selected' : ''}`}
              onClick={() => onSelectGhost(name)}
              onContextMenu={(event) => {
                event.preventDefault()
                setOpenMenuGhostName((current) => (current === name ? null : name))
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectGhost(name)
                }
              }}
            >
              <div className="ghost-row__main">
                <div className="ghost-row__meta">
                  <span
                    aria-hidden="true"
                    className={`status-dot status-dot--${ghost.status}`}
                  />
                  <div>
                    <p className="ghost-row__name">{name}</p>
                    <p className="ghost-row__model">{ghost.provider}/{ghost.model}</p>
                  </div>
                </div>
                <span className={`status-badge status-badge--${ghost.status}`}>
                  {ghost.status}
                </span>
              </div>

              <div className="ghost-row__menu">
                <button
                  aria-expanded={openMenuGhostName === name}
                  aria-label={`Open actions for ${name}`}
                  className="ghost-row__menu-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpenMenuGhostName((current) => (current === name ? null : name))
                  }}
                  type="button"
                >
                  ⋯
                </button>

                {openMenuGhostName === name ? (
                  <div className="menu-card" onClick={(event) => event.stopPropagation()}>
                    {ghost.status === 'running' ? (
                      <button
                        className="menu-card__action"
                        disabled={isBusy}
                        onClick={() => {
                          setOpenMenuGhostName(null)
                          onKillGhost(name)
                        }}
                        type="button"
                      >
                        Kill
                      </button>
                    ) : (
                      <button
                        className="menu-card__action"
                        disabled={isBusy}
                        onClick={() => {
                          setOpenMenuGhostName(null)
                          onWakeGhost(name)
                        }}
                        type="button"
                      >
                        Wake
                      </button>
                    )}

                    <button
                      className="menu-card__action"
                      disabled={isBusy}
                      onClick={() => {
                        setOpenMenuGhostName(null)
                        onSaveGhost(name)
                      }}
                      type="button"
                    >
                      Save vault
                    </button>

                    <button
                      className="menu-card__action menu-card__action--danger"
                      disabled={isBusy}
                      onClick={() => {
                        setOpenMenuGhostName(null)
                        onRemoveGhost(name)
                      }}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="button button--ghost sidebar__theme-toggle"
          onClick={onToggleTheme}
          type="button"
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </aside>
  )
}
