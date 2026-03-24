import { useEffect, useRef, useState } from 'react'
import type { GhostState } from '../api'
import type { ChatMessage } from '../ui-types'
import { MessageBubble } from './MessageBubble'

type ChatViewProps = {
  ghostName: string | null
  ghost: GhostState | null
  messages: ChatMessage[]
  pending: boolean
  onSend: (ghostName: string, prompt: string) => Promise<void>
}

export function ChatView({
  ghostName,
  ghost,
  messages,
  pending,
  onSend,
}: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const messagesRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = messagesRef.current
    if (!node) {
      return
    }

    node.scrollTop = node.scrollHeight
  }, [messages, pending])

  if (!ghostName || !ghost) {
    return (
      <section className="chat-view panel">
        <div className="chat-empty">
          <p className="eyebrow">Ghost chat</p>
          <h2>Pick a ghost from the sidebar</h2>
          <p>The conversation will appear here once you select one.</p>
        </div>
      </section>
    )
  }

  const canSend =
    draft.trim().length > 0 && ghost.status === 'running' && pending === false

  return (
    <section className="chat-view panel">
      <div className="chat-view__messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p className="eyebrow">Ghost chat</p>
            <h2>{ghostName}</h2>
            <p>
              {ghost.status === 'running'
                ? 'Start a conversation with this ghost.'
                : 'Wake this ghost before sending a message.'}
            </p>
          </div>
        ) : null}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {pending ? (
          <div className="message-row message-row--assistant">
            <div className="typing-indicator">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>

      <form
        className="chat-view__composer"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!canSend) {
            return
          }

          const prompt = draft.trim()
          setDraft('')
          await onSend(ghostName, prompt)
        }}
      >
        <textarea
          className="composer__input"
          disabled={ghost.status !== 'running' || pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (canSend) {
                void onSend(ghostName, draft.trim())
                setDraft('')
              }
            }
          }}
          placeholder={
            ghost.status === 'running'
              ? 'Send a prompt to this ghost...'
              : 'Wake this ghost to chat'
          }
          rows={3}
          value={draft}
        />
        <button className="button button--primary composer__button" disabled={!canSend} type="submit">
          Send
        </button>
      </form>
    </section>
  )
}
