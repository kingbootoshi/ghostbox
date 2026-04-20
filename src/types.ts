export type GhostStatus = "running" | "stopped";

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

export type GhostStreamingBehavior = "steer" | "followUp";

export interface GhostQueueState {
  steering: string[];
  followUp: string[];
  pendingCount: number;
}

export interface GhostQueueEnqueueResponse {
  status: "queued";
  pendingCount: number;
}

export interface GhostQueueClearResponse {
  cleared: {
    steering: string[];
    followUp: string[];
  };
}

export interface GhostSchedule {
  id: string;
  ghostName: string;
  cron: string;
  prompt: string;
  timezone: string;
  once: boolean;
  enabled: boolean;
  createdAt: string;
  lastFired: string | null;
  nextFire: string | null;
}

export interface MailMessage {
  id: string;
  from: string;
  authenticatedBy: string | null;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  threadId: string | null;
  priority: "normal" | "urgent";
}

export interface MailboxState {
  messages: MailMessage[];
}

export interface VaultEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
}

export interface GhostState {
  containerId: string;
  portBase: number;
  model: string;
  provider: string;
  adapter?: AdapterType;
  imageVersion: string;
  status: GhostStatus;
  createdAt: string;
  systemPrompt: string | null;
  apiKeys: GhostApiKey[];
}

export interface GhostboxConfig {
  telegramToken: string;
  githubToken: string | null;
  githubRemote: string | null;
  adminToken?: string;
  corsOrigins?: string[];
  defaultModel: string;
  defaultProvider: string;
  imageName: string;
  imageVersion: string;
  observerModel: string;
}

export interface GhostboxConfigSensitiveStatus {
  githubToken: boolean;
  telegramToken: boolean;
}

export interface GhostboxConfigResponse extends Omit<GhostboxConfig, "githubToken" | "telegramToken" | "adminToken"> {
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
  imageVersion: string;
  observerModel: string;
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
  type: "assistant";
  text: string;
};

export type ThinkingMessage = {
  type: "thinking";
  text: string;
};

export type ToolUseMessage = {
  type: "tool_use";
  tool: string;
  input: unknown;
};

export type ToolResultMessage = {
  type: "tool_result";
  output: unknown;
};

export type ResultMessage = {
  type: "result";
  text: string;
  sessionId: string;
};

export type HistoryMessage = {
  role: "user" | "assistant" | "system" | "tool_use" | "tool_result";
  text: string;
  toolName?: string;
  timestamp?: string;
  attachmentCount?: number;
  images?: GhostImage[];
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

export type SessionInfo = {
  id: string;
  name: string | null;
  path: string;
  createdAt: string;
  lastActiveAt: string;
};

export type SessionListResponse = {
  current: string;
  sessions: SessionInfo[];
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

export type HeartbeatMessage = { type: "heartbeat" };

export type GhostMessage =
  | ThinkingMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage
  | HeartbeatMessage;

export type AdapterType = "pi" | "claude-code";

export type AuthProvider = "anthropic" | "openai-codex";

export interface OAuthTokenRecord {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

export interface ClaudeCodeTokenRecord {
  type: "claude-code";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  source: "keychain" | "setup-token" | "direct";
}

export type AuthTokenStore = Partial<Record<AuthProvider, OAuthTokenRecord>> & {
  claudeCode?: ClaudeCodeTokenRecord;
};

export interface AuthProviderStatus {
  authenticated: boolean;
  expiresAt: number | null;
}

export interface AuthStatus {
  providers: Record<AuthProvider, AuthProviderStatus>;
  claudeCode: AuthProviderStatus;
}
