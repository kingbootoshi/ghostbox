import type { ToolCallChatMessage } from '../ui-types'

type ToolCallProps = {
  message: ToolCallChatMessage
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  return JSON.stringify(value, null, 2)
}

export function ToolCall({ message }: ToolCallProps) {
  return (
    <details className="tool-call">
      <summary className="tool-call__summary">
        <span className="tool-call__title">{message.tool}</span>
        <span className={`tool-call__status tool-call__status--${message.status}`}>
          {message.status}
        </span>
      </summary>

      <div className="tool-call__content">
        <div className="tool-call__section">
          <p className="tool-call__label">Input</p>
          <pre>{formatValue(message.input)}</pre>
        </div>

        {message.output !== undefined ? (
          <div className="tool-call__section">
            <p className="tool-call__label">Output</p>
            <pre>{formatValue(message.output)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}
