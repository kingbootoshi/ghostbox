import { useEffect, useState } from 'react'
import type { GhostProvider } from '../api'

type SpawnModalProps = {
  isOpen: boolean
  isSubmitting: boolean
  defaultModels: Record<GhostProvider, string>
  onClose: () => void
  onSubmit: (input: {
    name: string
    provider: GhostProvider
    model: string
    systemPrompt?: string
  }) => Promise<void>
}

export function SpawnModal({
  isOpen,
  isSubmitting,
  defaultModels,
  onClose,
  onSubmit,
}: SpawnModalProps) {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<GhostProvider>('anthropic')
  const [model, setModel] = useState(defaultModels.anthropic)
  const [systemPrompt, setSystemPrompt] = useState('')

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isSubmitting, onClose])

  if (!isOpen) {
    return null
  }

  return (
    <div className="modal-backdrop" onClick={isSubmitting ? undefined : onClose} role="presentation">
      <div className="modal panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div>
            <p className="eyebrow">New ghost</p>
            <h2 className="modal__title">Spawn a ghost</h2>
          </div>
          <button
            aria-label="Close spawn modal"
            className="icon-button icon-button--small"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <form
          className="modal__form"
          onSubmit={async (event) => {
            event.preventDefault()
            await onSubmit({
              name: name.trim(),
              provider,
              model: model.trim(),
              systemPrompt: systemPrompt.trim() || undefined,
            })
          }}
        >
          <label className="field">
            <span className="field__label">Name</span>
            <input
              autoFocus
              className="field__input"
              onChange={(event) => setName(event.target.value)}
              placeholder="my-ghost"
              required
              value={name}
            />
          </label>

          <label className="field">
            <span className="field__label">Provider</span>
            <select
              className="field__input"
              onChange={(event) => {
                const nextProvider = event.target.value as GhostProvider
                setProvider(nextProvider)
                setModel(defaultModels[nextProvider])
              }}
              value={provider}
            >
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">Model</span>
            <input
              className="field__input"
              onChange={(event) => setModel(event.target.value)}
              placeholder={defaultModels[provider]}
              value={model}
            />
          </label>

          <label className="field">
            <span className="field__label">System prompt</span>
            <textarea
              className="field__input field__input--textarea"
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="Optional instructions for this ghost"
              rows={6}
              value={systemPrompt}
            />
          </label>

          <div className="modal__actions">
            <button
              className="button button--ghost"
              disabled={isSubmitting}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--primary"
              disabled={isSubmitting || name.trim().length === 0 || model.trim().length === 0}
              type="submit"
            >
              {isSubmitting ? 'Spawning...' : 'Spawn ghost'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
