import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import {
  createGhostKey,
  killGhost,
  listGhostKeys,
  listGhosts,
  removeGhost,
  revokeGhostKey,
  saveGhostVault,
  spawnGhost,
  streamGhostMessage,
  wakeGhost,
  type GhostApiKey,
  type GhostMessage,
  type GhostProvider,
  type GhostState,
  type MessageStream,
} from './api'
import { ChatView } from './components/ChatView'
import { FileBrowser } from './components/FileBrowser'
import { GhostHeader } from './components/GhostHeader'
import { Sidebar } from './components/Sidebar'
import { SpawnModal } from './components/SpawnModal'
import type { ChatMessage, ToolCallChatMessage } from './ui-types'

const DEFAULT_MODEL_BY_PROVIDER: Record<GhostProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.3-codex',
}

const THEME_STORAGE_KEY = 'ghostbox-theme'

type ThemeMode = 'dark' | 'light'

const createId = (): string => crypto.randomUUID()

const getInitialTheme = (): ThemeMode => {
  if (typeof window === 'undefined') {
    return 'dark'
  }

  return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return 'Request failed'
}

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError'
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme())
  const [ghosts, setGhosts] = useState<Record<string, GhostState>>({})
  const [loadingGhosts, setLoadingGhosts] = useState(true)
  const [selectedGhostName, setSelectedGhostName] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'chat' | 'files'>('chat')
  const [messagesByGhost, setMessagesByGhost] = useState<Record<string, ChatMessage[]>>({})
  const [pendingByGhost, setPendingByGhost] = useState<Record<string, boolean>>({})
  const [actionStates, setActionStates] = useState<Record<string, string | undefined>>({})
  const [isSpawnModalOpen, setIsSpawnModalOpen] = useState(false)
  const [isSpawningGhost, setIsSpawningGhost] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [keysGhostName, setKeysGhostName] = useState<string | null>(null)
  const [ghostKeys, setGhostKeys] = useState<GhostApiKey[]>([])
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysSubmitting, setKeysSubmitting] = useState(false)
  const [newKeyLabel, setNewKeyLabel] = useState('default')
  const [hasUnsavedFileChanges, setHasUnsavedFileChanges] = useState(false)

  const streamsRef = useRef<Record<string, MessageStream>>({})
  const messageChainsRef = useRef<Record<string, Promise<void>>>({})

  const selectedGhost = selectedGhostName ? ghosts[selectedGhostName] ?? null : null
  const selectedMessages = selectedGhostName
    ? messagesByGhost[selectedGhostName] ?? []
    : []
  const selectedBusyLabel = selectedGhostName ? actionStates[selectedGhostName] : undefined

  const appendMessage = (ghostName: string, message: ChatMessage) => {
    setMessagesByGhost((current) => {
      const nextMessages = [...(current[ghostName] ?? []), message]
      return {
        ...current,
        [ghostName]: nextMessages,
      }
    })
  }

  const appendSystemMessage = (
    ghostName: string,
    text: string,
    tone: 'error' | 'info' = 'error',
  ) => {
    appendMessage(ghostName, {
      id: createId(),
      type: 'system',
      text,
      tone,
    })
  }

  const updateAssistantMessage = (
    ghostName: string,
    messageId: string,
    nextChunk: string,
  ) => {
    setMessagesByGhost((current) => {
      const nextMessages = (current[ghostName] ?? []).map((message) => {
        if (message.id !== messageId || message.type !== 'assistant') {
          return message
        }

        return {
          ...message,
          text: message.text + nextChunk,
        }
      })

      return {
        ...current,
        [ghostName]: nextMessages,
      }
    })
  }

  const addToolUseMessage = (
    ghostName: string,
    message: Extract<GhostMessage, { type: 'tool_use' }>,
  ) => {
    appendMessage(ghostName, {
      id: createId(),
      type: 'tool_call',
      tool: message.tool,
      input: message.input,
      status: 'running',
    })
  }

  const addToolResultMessage = (
    ghostName: string,
    message: Extract<GhostMessage, { type: 'tool_result' }>,
  ) => {
    setMessagesByGhost((current) => {
      const nextMessages = [...(current[ghostName] ?? [])]
      const pendingToolIndex = nextMessages.findLastIndex(
        (entry): entry is ToolCallChatMessage =>
          entry.type === 'tool_call' && entry.status === 'running',
      )

      if (pendingToolIndex >= 0) {
        const pendingTool = nextMessages[pendingToolIndex] as ToolCallChatMessage
        nextMessages[pendingToolIndex] = {
          ...pendingTool,
          output: message.output,
          status: 'done',
        }
      } else {
        nextMessages.push({
          id: createId(),
          type: 'tool_call',
          tool: 'tool-result',
          input: null,
          output: message.output,
          status: 'done',
        })
      }

      return {
        ...current,
        [ghostName]: nextMessages,
      }
    })
  }

  const animateAssistantMessage = async (ghostName: string, text: string) => {
    const messageId = createId()
    appendMessage(ghostName, {
      id: messageId,
      type: 'assistant',
      text: '',
    })

    const delay = text.length > 800 ? 3 : text.length > 300 ? 6 : 10

    for (const character of text) {
      updateAssistantMessage(ghostName, messageId, character)
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, delay)
      })
    }
  }

  const handleStreamMessage = async (ghostName: string, message: GhostMessage) => {
    if (message.type === 'assistant') {
      await animateAssistantMessage(ghostName, message.text)
      return
    }

    if (message.type === 'tool_use') {
      addToolUseMessage(ghostName, message)
      return
    }

    if (message.type === 'tool_result') {
      addToolResultMessage(ghostName, message)
      return
    }

    appendMessage(ghostName, {
      id: createId(),
      type: 'result',
      text: message.text,
      sessionId: message.sessionId,
    })
  }

  const refreshGhosts = useCallback(
    async (options?: { preferredGhostName?: string | null }) => {
      try {
        const nextGhosts = await listGhosts()
        startTransition(() => {
          setGhosts(nextGhosts)
        })
        setErrorMessage(null)

        if (options?.preferredGhostName && nextGhosts[options.preferredGhostName]) {
          setSelectedGhostName(options.preferredGhostName)
        }
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
      } finally {
        setLoadingGhosts(false)
      }
    },
    [],
  )

  const closeGhostStream = (ghostName: string) => {
    streamsRef.current[ghostName]?.close()
    delete streamsRef.current[ghostName]
    delete messageChainsRef.current[ghostName]
    setPendingByGhost((current) => ({
      ...current,
      [ghostName]: false,
    }))
  }

  const loadGhostKeys = useCallback(async (ghostName: string) => {
    setKeysLoading(true)

    try {
      const nextKeys = await listGhostKeys(ghostName)
      setGhostKeys(nextKeys)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setKeysLoading(false)
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    void refreshGhosts()

    const intervalId = window.setInterval(() => {
      void refreshGhosts()
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [refreshGhosts])

  useEffect(() => {
    if (selectedGhostName && ghosts[selectedGhostName]) {
      return
    }

    const [nextGhostName] = Object.keys(ghosts).sort((left, right) => left.localeCompare(right))
    setSelectedGhostName(nextGhostName ?? null)
  }, [ghosts, selectedGhostName])

  useEffect(() => {
    if (keysGhostName && !ghosts[keysGhostName]) {
      setKeysGhostName(null)
      setGhostKeys([])
    }
  }, [ghosts, keysGhostName])

  const chatPending = selectedGhostName
    ? pendingByGhost[selectedGhostName] ?? false
    : false

  const runGhostAction = async (
    ghostName: string,
    actionLabel: string,
    action: () => Promise<void>,
    options?: { closeStream?: boolean; clearSelection?: boolean },
  ) => {
    setActionStates((current) => ({
      ...current,
      [ghostName]: actionLabel,
    }))

    if (options?.closeStream) {
      closeGhostStream(ghostName)
    }

    try {
      await action()
      setErrorMessage(null)

      if (options?.clearSelection && selectedGhostName === ghostName) {
        setSelectedGhostName(null)
      }

      if (options?.clearSelection && keysGhostName === ghostName) {
        setKeysGhostName(null)
        setGhostKeys([])
      }

      await refreshGhosts({
        preferredGhostName: options?.clearSelection ? null : ghostName,
      })
    } catch (error) {
      setErrorMessage(toErrorMessage(error))
    } finally {
      setActionStates((current) => ({
        ...current,
        [ghostName]: undefined,
      }))
    }
  }

  const handleSend = async (ghostName: string, prompt: string) => {
    if ((pendingByGhost[ghostName] ?? false) || prompt.trim().length === 0) {
      return
    }

    appendMessage(ghostName, {
      id: createId(),
      type: 'user',
      text: prompt,
    })
    setPendingByGhost((current) => ({
      ...current,
      [ghostName]: true,
    }))
    setErrorMessage(null)

    const stream = streamGhostMessage(ghostName, { prompt }, {
      onMessage: (message) => {
        const currentChain = messageChainsRef.current[ghostName] ?? Promise.resolve()
        const nextChain = currentChain.then(() => handleStreamMessage(ghostName, message))
        messageChainsRef.current[ghostName] = nextChain.catch((error) => {
          appendSystemMessage(ghostName, toErrorMessage(error))
        })
      },
      onError: (error) => {
        if (!isAbortError(error)) {
          setErrorMessage(error.message)
        }
      },
    })

    streamsRef.current[ghostName] = stream
    messageChainsRef.current[ghostName] = Promise.resolve()

    void stream.done
      .then(async () => {
        await (messageChainsRef.current[ghostName] ?? Promise.resolve())
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }

        const nextErrorMessage = toErrorMessage(error)
        appendSystemMessage(ghostName, nextErrorMessage)
        setErrorMessage(nextErrorMessage)
      })
      .finally(() => {
        delete streamsRef.current[ghostName]
        delete messageChainsRef.current[ghostName]
        setPendingByGhost((current) => ({
          ...current,
          [ghostName]: false,
        }))
      })
  }

  return (
    <>
      <div className="app-shell">
        <Sidebar
          actionStates={actionStates}
          ghosts={ghosts}
          loading={loadingGhosts}
          onKillGhost={(ghostName) =>
            void runGhostAction(ghostName, 'kill', () => killGhost(ghostName), {
              closeStream: true,
            })
          }
          onOpenSpawnModal={() => setIsSpawnModalOpen(true)}
          onRemoveGhost={(ghostName) =>
            void runGhostAction(ghostName, 'remove', () => removeGhost(ghostName), {
              clearSelection: true,
              closeStream: true,
            })
          }
          onSaveGhost={(ghostName) =>
            void runGhostAction(ghostName, 'save', () => saveGhostVault(ghostName))
          }
          onSelectGhost={setSelectedGhostName}
          onToggleTheme={() =>
            setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'))
          }
          onWakeGhost={(ghostName) =>
            void runGhostAction(ghostName, 'wake', () => wakeGhost(ghostName))
          }
          selectedGhostName={selectedGhostName}
          theme={theme}
        />

        <main className="main-column">
          <GhostHeader
            activeView={activeView}
            busyLabel={selectedBusyLabel}
            ghost={selectedGhost}
            ghostName={selectedGhostName}
            hasUnsavedFileChanges={hasUnsavedFileChanges}
            onManageKeys={() => {
              if (!selectedGhostName) {
                return
              }

              setKeysGhostName(selectedGhostName)
              setNewKeyLabel('default')
              void loadGhostKeys(selectedGhostName)
            }}
            onSave={() => {
              if (!selectedGhostName) {
                return
              }

              void runGhostAction(selectedGhostName, 'save', () =>
                saveGhostVault(selectedGhostName),
              )
            }}
            onToggleStatus={() => {
              if (!selectedGhostName || !selectedGhost) {
                return
              }

              if (selectedGhost.status === 'running') {
                void runGhostAction(selectedGhostName, 'kill', () => killGhost(selectedGhostName), {
                  closeStream: true,
                })
                return
              }

              void runGhostAction(selectedGhostName, 'wake', () =>
                wakeGhost(selectedGhostName),
              )
            }}
            onToggleFiles={() => {
              if (!selectedGhostName) {
                return
              }

              setActiveView((current) => (current === 'chat' ? 'files' : 'chat'))
            }}
          />

          {errorMessage ? (
            <div className="error-banner panel">
              <p>{errorMessage}</p>
              <button
                aria-label="Dismiss error"
                className="icon-button icon-button--small"
                onClick={() => setErrorMessage(null)}
                type="button"
              >
                ×
              </button>
            </div>
          ) : null}

          <div hidden={activeView !== 'chat'}>
            <ChatView
              key={selectedGhostName ?? 'no-ghost'}
              ghost={selectedGhost}
              ghostName={selectedGhostName}
              messages={selectedMessages}
              onSend={handleSend}
              pending={chatPending}
            />
          </div>

          <div hidden={activeView !== 'files'}>
            <FileBrowser
              ghost={selectedGhost}
              ghostName={selectedGhostName}
              onDirtyChange={setHasUnsavedFileChanges}
            />
          </div>
        </main>
      </div>

      {isSpawnModalOpen ? (
        <SpawnModal
          defaultModels={DEFAULT_MODEL_BY_PROVIDER}
          isOpen={isSpawnModalOpen}
          isSubmitting={isSpawningGhost}
          onClose={() => {
            if (!isSpawningGhost) {
              setIsSpawnModalOpen(false)
            }
          }}
          onSubmit={async (input) => {
            setIsSpawningGhost(true)

            try {
              await spawnGhost(input)
              setSelectedGhostName(input.name)
              setIsSpawnModalOpen(false)
              setErrorMessage(null)
              await refreshGhosts({ preferredGhostName: input.name })
            } catch (error) {
              setErrorMessage(toErrorMessage(error))
            } finally {
              setIsSpawningGhost(false)
            }
          }}
        />
      ) : null}

      {keysGhostName ? (
        <div
          className="modal-backdrop"
          onClick={keysSubmitting ? undefined : () => setKeysGhostName(null)}
          role="presentation"
        >
          <div className="modal panel" onClick={(event) => event.stopPropagation()}>
            <div className="modal__header">
              <div>
                <p className="eyebrow">API keys</p>
                <h2 className="modal__title">{keysGhostName}</h2>
              </div>
              <button
                aria-label="Close keys modal"
                className="icon-button icon-button--small"
                disabled={keysSubmitting}
                onClick={() => setKeysGhostName(null)}
                type="button"
              >
                ×
              </button>
            </div>

            <form
              className="key-form"
              onSubmit={async (event) => {
                event.preventDefault()
                if (newKeyLabel.trim().length === 0) {
                  return
                }

                setKeysSubmitting(true)
                try {
                  await createGhostKey(keysGhostName, newKeyLabel.trim())
                  setNewKeyLabel('default')
                  await loadGhostKeys(keysGhostName)
                  setErrorMessage(null)
                } catch (error) {
                  setErrorMessage(toErrorMessage(error))
                } finally {
                  setKeysSubmitting(false)
                }
              }}
            >
              <label className="field field--inline">
                <span className="field__label">New key label</span>
                <div className="field__inline">
                  <input
                    className="field__input"
                    onChange={(event) => setNewKeyLabel(event.target.value)}
                    value={newKeyLabel}
                  />
                  <button
                    className="button button--primary"
                    disabled={keysSubmitting || keysLoading || newKeyLabel.trim().length === 0}
                    type="submit"
                  >
                    Create key
                  </button>
                </div>
              </label>
            </form>

            <div className="keys-list">
              {keysLoading ? <p className="sidebar__empty">Loading keys...</p> : null}

              {!keysLoading && ghostKeys.length === 0 ? (
                <p className="sidebar__empty">No keys yet.</p>
              ) : null}

              {ghostKeys.map((key) => (
                <article className="key-card" key={key.id}>
                  <div>
                    <p className="key-card__label">{key.label}</p>
                    <p className="key-card__meta">{key.createdAt}</p>
                    <code className="key-card__value">{key.key}</code>
                  </div>
                  <button
                    className="button button--danger"
                    disabled={keysSubmitting}
                    onClick={async () => {
                      setKeysSubmitting(true)
                      try {
                        await revokeGhostKey(keysGhostName, key.id)
                        await loadGhostKeys(keysGhostName)
                        setErrorMessage(null)
                      } catch (error) {
                        setErrorMessage(toErrorMessage(error))
                      } finally {
                        setKeysSubmitting(false)
                      }
                    }}
                    type="button"
                  >
                    Revoke
                  </button>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

export default App
