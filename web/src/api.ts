import type { GhostApiKey, GhostMessage, GhostState, VaultEntry } from '../../src/types.ts'

export type { GhostApiKey, GhostMessage, GhostState, VaultEntry }

export type GhostProvider = 'anthropic' | 'openai'

export type SpawnGhostInput = {
  name: string
  provider?: GhostProvider
  model?: string
  systemPrompt?: string
}

export type MessageStreamInput = {
  prompt: string
  model?: string
}

export type MessageStreamHandlers = {
  onMessage?: (message: GhostMessage) => void
  onDone?: () => void
  onError?: (error: Error) => void
}

export type MessageStream = {
  close: () => void
  done: Promise<void>
}

export type VaultFile = {
  path: string
  content: string
  size: number
}

const API_BASE = '/api'

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }

  return new Error('Request failed')
}

const parseErrorMessage = async (response: Response): Promise<string> => {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    try {
      const payload = (await response.json()) as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string') {
        return payload.error
      }
      if (typeof payload.message === 'string') {
        return payload.message
      }
    } catch {
      return `${response.status} ${response.statusText}`
    }
  }

  const text = await response.text()
  return text || `${response.status} ${response.statusText}`
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new ApiError(await parseErrorMessage(response), response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  if (!text) {
    return undefined as T
  }

  return JSON.parse(text) as T
}

type ParsedSseEvent = {
  event: string
  data: string
}

const parseSseChunk = (chunk: string): ParsedSseEvent | null => {
  const lines = chunk.split(/\r?\n/)
  let event = 'message'
  const data: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue
    }

    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }

    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart())
    }
  }

  if (data.length === 0 && event !== 'done') {
    return null
  }

  return {
    event,
    data: data.join('\n'),
  }
}

const readSseStream = async (
  response: Response,
  handlers: MessageStreamHandlers,
  signal: AbortSignal,
): Promise<void> => {
  if (!response.body) {
    throw new Error('Stream response did not include a body')
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    if (signal.aborted) {
      return
    }

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const event = parseSseChunk(part)
      if (!event) {
        continue
      }

      if (event.event === 'done') {
        handlers.onDone?.()
        continue
      }

      if (event.event === 'message') {
        handlers.onMessage?.(JSON.parse(event.data) as GhostMessage)
      }
    }
  }

  const trailing = buffer.trim()
  if (!trailing) {
    return
  }

  const event = parseSseChunk(trailing)
  if (!event) {
    return
  }

  if (event.event === 'done') {
    handlers.onDone?.()
    return
  }

  if (event.event === 'message') {
    handlers.onMessage?.(JSON.parse(event.data) as GhostMessage)
  }
}

export const listGhosts = async (): Promise<Record<string, GhostState>> => {
  return request<Record<string, GhostState>>('/ghosts')
}

export const spawnGhost = async (input: SpawnGhostInput): Promise<void> => {
  await request<void>('/ghosts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export const killGhost = async (name: string): Promise<void> => {
  await request<void>(`/ghosts/${encodeURIComponent(name)}/kill`, {
    method: 'POST',
  })
}

export const wakeGhost = async (name: string): Promise<void> => {
  await request<void>(`/ghosts/${encodeURIComponent(name)}/wake`, {
    method: 'POST',
  })
}

export const removeGhost = async (name: string): Promise<void> => {
  await request<void>(`/ghosts/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export const getGhostHealth = async (
  name: string,
): Promise<{ healthy: boolean }> => {
  return request<{ healthy: boolean }>(`/ghosts/${encodeURIComponent(name)}/health`)
}

export const listGhostKeys = async (name: string): Promise<GhostApiKey[]> => {
  return request<GhostApiKey[]>(`/ghosts/${encodeURIComponent(name)}/keys`)
}

export const createGhostKey = async (
  name: string,
  label: string,
): Promise<GhostApiKey> => {
  return request<GhostApiKey>(`/ghosts/${encodeURIComponent(name)}/keys`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  })
}

export const revokeGhostKey = async (
  name: string,
  keyId: string,
): Promise<void> => {
  await request<void>(
    `/ghosts/${encodeURIComponent(name)}/keys/${encodeURIComponent(keyId)}`,
    {
      method: 'DELETE',
    },
  )
}

export const saveGhostVault = async (name: string): Promise<void> => {
  await request<void>(`/ghosts/${encodeURIComponent(name)}/save`, {
    method: 'POST',
  })
}

export const listVaultFiles = async (
  ghostName: string,
  path = '/',
): Promise<VaultEntry[]> => {
  const params = new URLSearchParams({ path })
  const response = await request<{ entries: VaultEntry[] }>(
    `/ghosts/${encodeURIComponent(ghostName)}/vault?${params.toString()}`,
  )

  return response.entries
}

export const readVaultFile = async (
  ghostName: string,
  path: string,
): Promise<VaultFile> => {
  const params = new URLSearchParams({ path })
  return request<VaultFile>(
    `/ghosts/${encodeURIComponent(ghostName)}/vault/read?${params.toString()}`,
  )
}

export const writeVaultFile = async (
  ghostName: string,
  path: string,
  content: string,
): Promise<{ path: string; size: number }> => {
  return request<{ path: string; size: number }>(
    `/ghosts/${encodeURIComponent(ghostName)}/vault/write`,
    {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    },
  )
}

export const deleteVaultFile = async (
  ghostName: string,
  path: string,
): Promise<void> => {
  await request<void>(`/ghosts/${encodeURIComponent(ghostName)}/vault/delete`, {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  })
}

export const streamGhostMessage = (
  name: string,
  input: MessageStreamInput,
  handlers: MessageStreamHandlers = {},
): MessageStream => {
  const controller = new AbortController()

  const done = (async () => {
    const response = await fetch(`${API_BASE}/ghosts/${encodeURIComponent(name)}/message`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new ApiError(await parseErrorMessage(response), response.status)
    }

    await readSseStream(response, handlers, controller.signal)
  })().catch((error: unknown) => {
    if (controller.signal.aborted) {
      return
    }

    const normalized = toError(error)
    handlers.onError?.(normalized)
    throw normalized
  })

  return {
    close: () => controller.abort(),
    done,
  }
}
