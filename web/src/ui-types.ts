export type UserChatMessage = {
  id: string
  type: 'user'
  text: string
}

export type AssistantChatMessage = {
  id: string
  type: 'assistant'
  text: string
}

export type ToolCallChatMessage = {
  id: string
  type: 'tool_call'
  tool: string
  input: unknown
  output?: unknown
  status: 'running' | 'done'
}

export type ResultChatMessage = {
  id: string
  type: 'result'
  text: string
  sessionId: string
}

export type SystemChatMessage = {
  id: string
  type: 'system'
  text: string
  tone: 'error' | 'info'
}

export type ChatMessage =
  | UserChatMessage
  | AssistantChatMessage
  | ToolCallChatMessage
  | ResultChatMessage
  | SystemChatMessage
