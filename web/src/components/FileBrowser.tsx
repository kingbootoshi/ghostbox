import { useCallback, useEffect, useState } from 'react'
import {
  deleteVaultFile,
  listVaultFiles,
  readVaultFile,
  writeVaultFile,
  type GhostState,
  type VaultEntry,
} from '../api'

type FileBrowserProps = {
  ghostName: string | null
  ghost: GhostState | null
  onDirtyChange?: (dirty: boolean) => void
}

const ROOT_PATH = '/'

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return 'Request failed'
}

const normalizeBrowserPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').trim()

  if (!normalized || normalized === '/') {
    return ROOT_PATH
  }

  return `/${normalized.split('/').filter(Boolean).join('/')}`
}

const getParentPath = (path: string): string => {
  const normalized = normalizeBrowserPath(path)

  if (normalized === ROOT_PATH) {
    return ROOT_PATH
  }

  const parts = normalized.split('/').filter(Boolean)
  parts.pop()

  return parts.length === 0 ? ROOT_PATH : `/${parts.join('/')}`
}

const getDirectoryChain = (path: string): string[] => {
  const normalized = normalizeBrowserPath(path)
  const parts = normalized.split('/').filter(Boolean)
  const chain = [ROOT_PATH]

  let currentPath = ''
  for (const part of parts) {
    currentPath += `/${part}`
    chain.push(currentPath)
  }

  return chain
}

const resolveDraftPath = (basePath: string, nextPath: string): string => {
  const trimmed = nextPath.trim()

  if (!trimmed) {
    return ROOT_PATH
  }

  if (trimmed.startsWith('/')) {
    return normalizeBrowserPath(trimmed)
  }

  return normalizeBrowserPath(
    basePath === ROOT_PATH ? `/${trimmed}` : `${basePath}/${trimmed}`,
  )
}

const getBreadcrumbs = (
  path: string,
  hasSelectedFile: boolean,
): Array<{ label: string; path: string; type: 'directory' | 'file' }> => {
  const normalized = normalizeBrowserPath(path)
  const parts = normalized.split('/').filter(Boolean)

  if (parts.length === 0) {
    return [{ label: 'vault', path: ROOT_PATH, type: 'directory' }]
  }

  let currentPath = ''

  return [
    { label: 'vault', path: ROOT_PATH, type: 'directory' },
    ...parts.map((part, index) => {
      currentPath += `/${part}`
      const isLast = index === parts.length - 1

      return {
        label: part,
        path: currentPath,
        type: hasSelectedFile && isLast ? 'file' : 'directory',
      }
    }),
  ]
}

const sortEntries = (entries: VaultEntry[]): VaultEntry[] => {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })
}

export function FileBrowser({
  ghostName,
  ghost,
  onDirtyChange,
}: FileBrowserProps) {
  const [entriesByPath, setEntriesByPath] = useState<Record<string, VaultEntry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<string[]>([ROOT_PATH])
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({})
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState(ROOT_PATH)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [savedContent, setSavedContent] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [savingFile, setSavingFile] = useState(false)
  const [deletingFile, setDeletingFile] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const hasUnsavedChanges =
    selectedFilePath !== null && draftContent !== savedContent

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!ghostName) {
        return
      }

      const normalizedPath = normalizeBrowserPath(path)

      setLoadingPaths((current) => ({
        ...current,
        [normalizedPath]: true,
      }))

      try {
        const entries = await listVaultFiles(ghostName, normalizedPath)
        setEntriesByPath((current) => ({
          ...current,
          [normalizedPath]: sortEntries(entries),
        }))
        setErrorMessage(null)
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
      } finally {
        setLoadingPaths((current) => ({
          ...current,
          [normalizedPath]: false,
        }))
      }
    },
    [ghostName],
  )

  const expandDirectoryChain = useCallback((path: string) => {
    const nextPaths = getDirectoryChain(path)

    setExpandedPaths((current) => {
      return Array.from(new Set([...current, ...nextPaths]))
    })
  }, [])

  const loadFile = useCallback(
    async (path: string, options?: { skipDirtyCheck?: boolean }) => {
      if (!ghostName) {
        return
      }

      const normalizedPath = normalizeBrowserPath(path)

      if (selectedFilePath === normalizedPath && !options?.skipDirtyCheck) {
        return
      }

      if (
        !options?.skipDirtyCheck &&
        hasUnsavedChanges &&
        selectedFilePath &&
        selectedFilePath !== normalizedPath &&
        !window.confirm('Discard unsaved changes?')
      ) {
        return
      }

      setLoadingFile(true)
      setSelectedDirectoryPath(getParentPath(normalizedPath))

      try {
        const file = await readVaultFile(ghostName, normalizedPath)
        expandDirectoryChain(getParentPath(file.path))
        setSelectedFilePath(file.path)
        setSavedContent(file.content)
        setDraftContent(file.content)
        setErrorMessage(null)
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
      } finally {
        setLoadingFile(false)
      }
    },
    [expandDirectoryChain, ghostName, hasUnsavedChanges, selectedFilePath],
  )

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges)
  }, [hasUnsavedChanges, onDirtyChange])

  useEffect(() => {
    setEntriesByPath({})
    setExpandedPaths([ROOT_PATH])
    setLoadingPaths({})
    setSelectedDirectoryPath(ROOT_PATH)
    setSelectedFilePath(null)
    setSavedContent('')
    setDraftContent('')
    setLoadingFile(false)
    setSavingFile(false)
    setDeletingFile(false)
    setErrorMessage(null)
    setStatusMessage(null)

    if (!ghostName || !ghost) {
      return
    }

    void loadDirectory(ROOT_PATH)
  }, [ghost, ghostName, loadDirectory])

  if (!ghostName || !ghost) {
    return (
      <section className="file-browser panel">
        <div className="chat-empty">
          <p className="eyebrow">Ghost files</p>
          <h2>Pick a ghost from the sidebar</h2>
          <p>The vault file browser will appear here once you select one.</p>
        </div>
      </section>
    )
  }

  const currentPath = selectedFilePath ?? selectedDirectoryPath
  const breadcrumbs = getBreadcrumbs(currentPath, selectedFilePath !== null)
  const canSave = Boolean(selectedFilePath) && hasUnsavedChanges && !savingFile && !loadingFile
  const canDelete = Boolean(selectedFilePath) && !deletingFile && !loadingFile
  const rootEntries = entriesByPath[ROOT_PATH] ?? []
  const isRootLoading = loadingPaths[ROOT_PATH] === true && rootEntries.length === 0

  const handleToggleDirectory = (entryPath: string) => {
    const normalizedPath = normalizeBrowserPath(entryPath)
    const isExpanded = expandedPaths.includes(normalizedPath)

    setSelectedDirectoryPath(normalizedPath)

    if (isExpanded) {
      setExpandedPaths((current) => current.filter((path) => path !== normalizedPath))
      return
    }

    expandDirectoryChain(normalizedPath)
    void loadDirectory(normalizedPath)
  }

  const handleSave = async () => {
    if (!ghostName || !selectedFilePath || !hasUnsavedChanges) {
      return
    }

    setSavingFile(true)

    try {
      const response = await writeVaultFile(ghostName, selectedFilePath, draftContent)
      setSelectedFilePath(response.path)
      setSavedContent(draftContent)
      setStatusMessage(`Saved ${response.path}`)
      setErrorMessage(null)
      await loadDirectory(getParentPath(response.path))
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setSavingFile(false)
    }
  }

  const handleCreateFile = async () => {
    if (!ghostName) {
      return
    }

    const basePath = selectedFilePath
      ? getParentPath(selectedFilePath)
      : selectedDirectoryPath
    const suggestedPath =
      basePath === ROOT_PATH ? '/untitled.md' : `${basePath}/untitled.md`
    const input = window.prompt('New file path', suggestedPath)

    if (input === null) {
      return
    }

    const nextPath = resolveDraftPath(basePath, input)
    if (nextPath === ROOT_PATH) {
      setErrorMessage('A file path is required')
      return
    }

    if (hasUnsavedChanges && !window.confirm('Discard unsaved changes?')) {
      return
    }

    setSavingFile(true)

    try {
      await writeVaultFile(ghostName, nextPath, '')
      const parentPath = getParentPath(nextPath)

      expandDirectoryChain(parentPath)
      await Promise.all(getDirectoryChain(parentPath).map((path) => loadDirectory(path)))
      await loadFile(nextPath, { skipDirtyCheck: true })
      setStatusMessage(`Created ${nextPath}`)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setSavingFile(false)
    }
  }

  const handleDelete = async () => {
    if (!ghostName || !selectedFilePath) {
      return
    }

    if (!window.confirm(`Delete ${selectedFilePath}?`)) {
      return
    }

    setDeletingFile(true)

    try {
      const deletedPath = selectedFilePath
      const parentPath = getParentPath(deletedPath)

      await deleteVaultFile(ghostName, deletedPath)
      await loadDirectory(parentPath)
      setSelectedFilePath(null)
      setSelectedDirectoryPath(parentPath)
      setSavedContent('')
      setDraftContent('')
      setStatusMessage(`Deleted ${deletedPath}`)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setDeletingFile(false)
    }
  }

  const renderTree = (path: string, depth = 0): JSX.Element | null => {
    const entries = entriesByPath[path]

    if (!entries) {
      if (loadingPaths[path]) {
        return (
          <div className="file-tree__status" style={{ paddingLeft: `${depth * 18 + 16}px` }}>
            Loading...
          </div>
        )
      }

      return null
    }

    if (entries.length === 0) {
      return (
        <div className="file-tree__status" style={{ paddingLeft: `${depth * 18 + 16}px` }}>
          Empty directory
        </div>
      )
    }

    return (
      <ul className="file-tree__list">
        {entries.map((entry) => {
          const isDirectory = entry.type === 'directory'
          const isExpanded = isDirectory && expandedPaths.includes(entry.path)
          const isSelectedFile = selectedFilePath === entry.path
          const isSelectedDirectory = !isSelectedFile && selectedDirectoryPath === entry.path

          return (
            <li className="file-tree__item" key={entry.path}>
              <button
                className={[
                  'file-tree__button',
                  isSelectedFile ? 'file-tree__button--selected' : '',
                  isSelectedDirectory ? 'file-tree__button--directory' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (isDirectory) {
                    handleToggleDirectory(entry.path)
                    return
                  }

                  void loadFile(entry.path)
                }}
                style={{ paddingLeft: `${depth * 18 + 14}px` }}
                type="button"
              >
                <span className="file-tree__chevron" aria-hidden="true">
                  {isDirectory ? (isExpanded ? '▾' : '▸') : ''}
                </span>
                <span className="file-tree__icon" aria-hidden="true">
                  {isDirectory ? '📁' : '📄'}
                </span>
                <span className="file-tree__label">
                  {entry.name}
                  {isSelectedFile && hasUnsavedChanges ? ' *' : ''}
                </span>
              </button>

              {isDirectory && isExpanded ? renderTree(entry.path, depth + 1) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <section className="file-browser panel">
      <div className="file-browser__topbar">
        <nav aria-label="Current file path" className="file-browser__breadcrumbs">
          {breadcrumbs.map((segment, index) => {
            const isLast = index === breadcrumbs.length - 1
            const label =
              isLast && segment.type === 'file' && hasUnsavedChanges
                ? `${segment.label} *`
                : segment.label

            return (
              <span className="file-browser__breadcrumb-segment" key={segment.path}>
                {segment.type === 'directory' ? (
                  <button
                    className="file-browser__breadcrumb-button"
                    onClick={() => {
                      setSelectedDirectoryPath(segment.path)
                      expandDirectoryChain(segment.path)
                      void loadDirectory(segment.path)
                    }}
                    type="button"
                  >
                    {label}
                  </button>
                ) : (
                  <span className="file-browser__breadcrumb-current">{label}</span>
                )}

                {!isLast ? <span className="file-browser__breadcrumb-separator">/</span> : null}
              </span>
            )
          })}
        </nav>

        <div className="file-browser__actions">
          <button
            className="button button--ghost"
            disabled={!canSave}
            onClick={() => void handleSave()}
            type="button"
          >
            {savingFile ? 'Saving...' : 'Save'}
          </button>
          <button
            className="button button--ghost"
            disabled={savingFile || deletingFile}
            onClick={() => void handleCreateFile()}
            type="button"
          >
            New file
          </button>
          <button
            className="button button--danger"
            disabled={!canDelete}
            onClick={() => void handleDelete()}
            type="button"
          >
            {deletingFile ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      {errorMessage ? <div className="file-browser__notice file-browser__notice--error">{errorMessage}</div> : null}
      {statusMessage ? <div className="file-browser__notice">{statusMessage}</div> : null}

      <div className="file-browser__content">
        <aside className="file-tree">
          <div className="file-tree__header">
            <p className="eyebrow">Vault tree</p>
          </div>

          <div className="file-tree__body">
            {isRootLoading ? <div className="file-tree__status">Loading files...</div> : null}
            {!isRootLoading && rootEntries.length === 0 ? (
              <div className="file-tree__status">No files yet</div>
            ) : null}
            {renderTree(ROOT_PATH)}
          </div>
        </aside>

        <div className="file-editor">
          <div className="file-editor__header">
            <p className="eyebrow">Editor</p>
            <p className="file-editor__meta">
              {selectedFilePath
                ? `${selectedFilePath}${hasUnsavedChanges ? ' - unsaved changes' : ''}`
                : 'Select a file to view or edit it'}
            </p>
          </div>

          {loadingFile ? (
            <div className="file-editor__empty">Loading file...</div>
          ) : selectedFilePath ? (
            <textarea
              className="file-editor__textarea"
              disabled={savingFile || deletingFile}
              onChange={(event) => setDraftContent(event.target.value)}
              spellCheck={false}
              value={draftContent}
            />
          ) : (
            <div className="file-editor__empty">
              Pick a file from the tree or create a new one.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
