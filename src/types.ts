export type GhostStatus = 'running' | 'stopped';

export interface GhostApiKey {
  id: string;
  key: string;
  label: string;
  createdAt: string;
}

export interface GhostImage {
  mediaType: string;
  data: string;
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

export interface GhostboxConfigSensitiveStatus {
  githubToken: boolean;
  telegramToken: boolean;
}

export interface GhostboxConfigResponse
  extends Omit<GhostboxConfig, 'githubToken' | 'telegramToken'> {
  githubToken: string;
  telegramToken: string;
  hasSensitive: GhostboxConfigSensitiveStatus;
}

export type GhostboxConfigUpdate = Partial<{
  telegramToken: string | null;
  githubToken: string | null;
  githubRemote: string | null;
  defaultModel: string;
  defaultProvider: string;
  imageName: string;
}>;

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

export type CompactionInfo = {
  timestamp: string;
  summary: string;
  tokensBefore: number;
};

export type HistoryResponse = {
  messages: HistoryMessage[];
  preCompactionMessages: HistoryMessage[];
  compactions: CompactionInfo[];
};

export type GhostStats = {
  sessionId: string;
  model: string;
  tokens: number;
  cost: number;
  messageCount: number;
  context: {
    used: number;
    window: number;
    percent: number;
  } | null;
};

export type GhostMessage =
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage;
