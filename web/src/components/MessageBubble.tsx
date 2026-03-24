import type { ReactNode } from 'react'
import type { ChatMessage } from '../ui-types'
import { ToolCall } from './ToolCall'

type MessageBubbleProps = {
  message: ChatMessage
}

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'unordered-list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; language: string; text: string }

const isBlockStart = (line: string): boolean => {
  return /^(#{1,3}\s+|```|>\s?|[-*]\s+|\d+\.\s+)/.test(line)
}

const parseMarkdownBlocks = (markdown: string): MarkdownBlock[] => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]

    if (line.trim().length === 0) {
      index += 1
      continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length) {
        index += 1
      }

      blocks.push({
        type: 'code',
        language,
        text: codeLines.join('\n'),
      })
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []

      while (index < lines.length) {
        const quoteMatch = lines[index].match(/^>\s?(.*)$/)
        if (!quoteMatch) {
          break
        }
        quoteLines.push(quoteMatch[1])
        index += 1
      }

      blocks.push({
        type: 'blockquote',
        text: quoteLines.join(' '),
      })
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []

      while (index < lines.length) {
        const itemMatch = lines[index].match(/^[-*]\s+(.*)$/)
        if (!itemMatch) {
          break
        }
        items.push(itemMatch[1])
        index += 1
      }

      blocks.push({
        type: 'unordered-list',
        items,
      })
      continue
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []

      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\d+\.\s+(.*)$/)
        if (!itemMatch) {
          break
        }
        items.push(itemMatch[1])
        index += 1
      }

      blocks.push({
        type: 'ordered-list',
        items,
      })
      continue
    }

    const paragraphLines = [line]
    index += 1

    while (index < lines.length) {
      const nextLine = lines[index]
      if (nextLine.trim().length === 0 || isBlockStart(nextLine)) {
        break
      }
      paragraphLines.push(nextLine)
      index += 1
    }

    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join(' '),
    })
  }

  return blocks
}

const renderInlineMarkdown = (text: string, keyPrefix: string): ReactNode[] => {
  const tokens: ReactNode[] = []
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g
  let lastIndex = 0
  let match = pattern.exec(text)
  let index = 0

  while (match) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    const key = `${keyPrefix}-${index}`

    if (token.startsWith('`')) {
      tokens.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      tokens.push(
        <strong key={key}>
          {renderInlineMarkdown(token.slice(2, -2), `${key}-strong`)}
        </strong>,
      )
    } else if (token.startsWith('*')) {
      tokens.push(
        <em key={key}>{renderInlineMarkdown(token.slice(1, -1), `${key}-em`)}</em>,
      )
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        tokens.push(
          <a href={linkMatch[2]} key={key} rel="noreferrer" target="_blank">
            {linkMatch[1]}
          </a>,
        )
      }
    }

    lastIndex = match.index + token.length
    index += 1
    match = pattern.exec(text)
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex))
  }

  return tokens
}

const renderMarkdown = (markdown: string): ReactNode => {
  const blocks = parseMarkdownBlocks(markdown)

  return blocks.map((block, blockIndex) => {
    const key = `block-${blockIndex}`

    if (block.type === 'heading') {
      if (block.level === 1) {
        return <h1 key={key}>{renderInlineMarkdown(block.text, key)}</h1>
      }

      if (block.level === 2) {
        return <h2 key={key}>{renderInlineMarkdown(block.text, key)}</h2>
      }

      return <h3 key={key}>{renderInlineMarkdown(block.text, key)}</h3>
    }

    if (block.type === 'unordered-list') {
      return (
        <ul key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      )
    }

    if (block.type === 'ordered-list') {
      return (
        <ol key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      )
    }

    if (block.type === 'blockquote') {
      return <blockquote key={key}>{renderInlineMarkdown(block.text, key)}</blockquote>
    }

    if (block.type === 'code') {
      return (
        <pre className="markdown-code" data-language={block.language} key={key}>
          <code>{block.text}</code>
        </pre>
      )
    }

    return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>
  })
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.type === 'tool_call') {
    return (
      <div className="message-row message-row--assistant">
        <div className="message-bubble message-bubble--tool">
          <ToolCall message={message} />
        </div>
      </div>
    )
  }

  if (message.type === 'assistant') {
    return (
      <div className="message-row message-row--assistant">
        <article className="message-bubble message-bubble--assistant">
          {renderMarkdown(message.text)}
        </article>
      </div>
    )
  }

  if (message.type === 'user') {
    return (
      <div className="message-row message-row--user">
        <article className="message-bubble message-bubble--user">
          <p>{message.text}</p>
        </article>
      </div>
    )
  }

  if (message.type === 'result') {
    return (
      <div className="message-row message-row--result">
        <article className="message-bubble message-bubble--result">
          {message.text ? <p>{message.text}</p> : null}
          <p className="message-result__meta">Session: {message.sessionId}</p>
        </article>
      </div>
    )
  }

  return (
    <div className="message-row message-row--system">
      <article
        className={`message-bubble message-bubble--system message-bubble--system-${message.tone}`}
      >
        <p>{message.text}</p>
      </article>
    </div>
  )
}
