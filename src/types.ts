export type GhostStatus = 'running' | 'stopped';

export interface GhostApiKey {
  id: string;
  key: string;
  label: string;
  createdAt: string;
}

export interface VaultEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
}

export interface GhostState {
  containerId: string;
  portBase: number;
  model: string;
  provider: string;
  status: GhostStatus;
  createdAt: string;
  systemPrompt: string | null;
  apiKeys: GhostApiKey[];
}

export interface GhostboxConfig {
  telegramToken: string;
  githubToken: string | null;
  githubRemote: string | null;
  defaultModel: string;
  defaultProvider: string;
  imageName: string;
}

export interface TelegramState {
  activeChatGhosts: Record<string, string>;
}

export interface GhostboxState {
  ghosts: Record<string, GhostState>;
  config: GhostboxConfig;
  telegram: TelegramState;
}

export type AssistantMessage = {
  type: 'assistant';
  text: string;
};

export type ToolUseMessage = {
  type: 'tool_use';
  tool: string;
  input: unknown;
};

export type ToolResultMessage = {
  type: 'tool_result';
  output: unknown;
};

export type ResultMessage = {
  type: 'result';
  text: string;
  sessionId: string;
};

export type HistoryMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  text: string;
  toolName?: string;
  timestamp?: string;
};

export type HistoryResponse = {
  messages: HistoryMessage[];
};

export type GhostMessage =
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage;
