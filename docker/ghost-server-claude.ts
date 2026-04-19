import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type {
  CompactionInfo,
  GhostImage,
  GhostMessage,
  GhostQueueClearResponse,
  GhostQueueState,
  GhostSchedule,
  GhostStats,
  HistoryMessage,
  HistoryResponse,
  SessionInfo,
  SessionListResponse
} from "../src/types";

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || "/vault/.claude";
const CLAUDE_PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, "projects", "-vault");
const CLAUDE_MCP_CONFIG_PATH = join(CLAUDE_CONFIG_DIR, ".mcp.json");
const CLAUDE_APPEND_PROMPT_PATH = join(CLAUDE_CONFIG_DIR, "ghostbox-system-prompt.md");
const GHOSTBOX_SKILL_PATH = "/opt/ghostbox/skills/ghostbox-api/SKILL.md";
const GHOSTBOX_API_PORT = process.env.GHOSTBOX_API_PORT || "8008";
const GHOSTBOX_HOST_BASE = `http://host.docker.internal:${GHOSTBOX_API_PORT}`;
const GHOSTBOX_GHOST_NAME = process.env.GHOSTBOX_GHOST_NAME || "";
const SYSTEM_PROMPT = process.env.GHOSTBOX_SYSTEM_PROMPT?.trim() || "";
const MEMORY_PATH = "/vault/MEMORY.md";
const USER_PATH = "/vault/USER.md";
const HEARTBEAT_INTERVAL_MS = 30_000;

type JsonRecord = Record<string, unknown>;

type QueueState = {
  messages: string[];
};

type StreamState = {
  textBuffer: string;
  lastAssistantText: string;
  assistantFallback: string;
  thinkingBuffer: string;
  currentBlockType: "text" | "thinking" | "tool_use" | null;
  currentToolName: string | null;
  currentToolInputBuffer: string;
  currentToolInputValue: unknown;
  emittedAssistantForBlock: boolean;
};

type ActiveTurn = {
  child: ChildProcessWithoutNullStreams;
  heartbeat: ReturnType<typeof setInterval> | null;
  buffer: string;
  finished: boolean;
  pendingResultSessionId: string | null;
};

type ClaudeResultUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

type ClaudeStatsSnapshot = GhostStats & {
  updatedAt: string;
};

type RequestBodyMessage = {
  prompt?: unknown;
  model?: unknown;
  images?: unknown;
  streamingBehavior?: unknown;
};

type RequestBodySteer = {
  prompt?: unknown;
  images?: unknown;
};

type RequestBodySessionSwitch = {
  sessionId?: unknown;
};

type RequestBodySessionRename = {
  sessionId?: unknown;
  name?: unknown;
};

type ScheduleBody = {
  cron?: unknown;
  prompt?: unknown;
  once?: unknown;
  timezone?: unknown;
};

const parseApiKeys = (value: string | undefined): string[] => {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("GHOSTBOX_API_KEYS must be a JSON array of strings");
  }

  return parsed;
};

const configuredApiKeys = parseApiKeys(process.env.GHOSTBOX_API_KEYS);

const log = (level: "INFO" | "ERROR", message: string, context?: JsonRecord): void => {
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  const line = `[${new Date().toISOString()}] [ghost-server-claude] ${level} ${message}${suffix}\n`;
  process.stderr.write(line);
};

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === "object" && value !== null;
};

const getString = (value: unknown): string | null => {
  return typeof value === "string" ? value : null;
};

const getNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const getBoolean = (value: unknown): boolean | null => {
  return typeof value === "boolean" ? value : null;
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) {
          return "";
        }

        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }

        if (typeof item.content === "string") {
          return item.content;
        }

        return "";
      })
      .join("");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
  }

  return "";
};

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const stripAnthropicPrefix = (value: string): string => {
  return value.startsWith("anthropic/") ? value.slice("anthropic/".length) : value;
};

const getInitialModel = (): string => {
  const configured = process.env.GHOSTBOX_MODEL?.trim();
  if (!configured) {
    return "claude-sonnet-4-6";
  }

  return stripAnthropicPrefix(configured);
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendJsonError = (res: ServerResponse, status: number, message: string, extra?: JsonRecord): void => {
  sendJson(res, status, { error: message, ...(extra ?? {}) });
};

const startNdjsonResponse = (res: ServerResponse): void => {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
};

const sendJsonLine = (res: ServerResponse, payload: GhostMessage): void => {
  res.write(`${JSON.stringify(payload)}\n`);
};

const sendAssistantResult = (res: ServerResponse, text: string, sessionId: string): void => {
  sendJsonLine(res, { type: "assistant", text });
  sendJsonLine(res, { type: "result", text, sessionId });
  res.end();
};

const getRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const parseJsonBody = async <T>(req: IncomingMessage): Promise<T> => {
  const body = await getRequestBody(req);
  if (!body.trim()) {
    return {} as T;
  }

  return JSON.parse(body) as T;
};

const parseJsonBodyOrRespond = async <T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> => {
  try {
    return await parseJsonBody<T>(req);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJsonError(res, 400, "Invalid JSON body");
      return undefined;
    }
    throw error;
  }
};

const ensureNoImages = (imagesValue: unknown): { error?: string } => {
  if (imagesValue === undefined) {
    return {};
  }

  if (!Array.isArray(imagesValue)) {
    return { error: "Invalid images" };
  }

  if (imagesValue.length > 0) {
    return { error: "Images are not supported by the claude-code adapter." };
  }

  return {};
};

const getSessionFilePath = (sessionId: string): string => {
  return join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`);
};

const readJsonLines = async (path: string): Promise<JsonRecord[]> => {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const sessionFileExists = async (sessionId: string | null): Promise<boolean> => {
  if (!sessionId) {
    return false;
  }
  return fileExists(getSessionFilePath(sessionId));
};

const formatUsage = (usage: ClaudeResultUsage | null): GhostStats => ({
  sessionId: currentSessionId ?? "",
  model: currentModel,
  tokens: usage?.totalTokens ?? 0,
  cost: usage?.cost ?? 0,
  messageCount: usage ? 0 : 0,
  context: null
});

const readFileText = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

const ensureClaudeSupportFiles = async (): Promise<void> => {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await mkdir(CLAUDE_PROJECTS_DIR, { recursive: true, mode: 0o700 });

  const skillText = await readFileText(GHOSTBOX_SKILL_PATH);
  const promptParts = [SYSTEM_PROMPT, skillText.trim()].filter((part) => part.length > 0);
  await writeFile(CLAUDE_APPEND_PROMPT_PATH, `${promptParts.join("\n\n")}\n`, "utf8");

  if (!(await fileExists(CLAUDE_MCP_CONFIG_PATH))) {
    const payload = {
      mcpServers: {
        ghostbox: {
          command: "node",
          args: ["/ghostbox-mcp-server.js"]
        }
      }
    };
    await writeFile(CLAUDE_MCP_CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
};

const createUserTurn = (text: string): string => {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: text
    }
  })}\n`;
};

const hostRequest = async (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> => {
  const response = await fetch(`${GHOSTBOX_HOST_BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(configuredApiKeys[0] ? { Authorization: `Bearer ${configuredApiKeys[0]}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const text = await response.text();

  if (!response.ok) {
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") {
          throw new Error(parsed.error);
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
      }
    }

    throw new Error(`Host request failed with status ${response.status}.`);
  }

  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text) as unknown;
};

const readSessionTimestamp = (line: JsonRecord | undefined, fallback: Date): string => {
  if (!line) {
    return fallback.toISOString();
  }

  const candidates = [line.timestamp, line.createdAt, line.created_at, line.time];
  for (const candidate of candidates) {
    const stringValue = getString(candidate);
    if (stringValue) {
      return stringValue;
    }
    const numberValue = getNumber(candidate);
    if (numberValue !== null) {
      return new Date(numberValue).toISOString();
    }
  }

  return fallback.toISOString();
};

const parseHistoryMessage = (line: JsonRecord): HistoryMessage | null => {
  const role = getString(line.type);
  const timestamp = readSessionTimestamp(line, new Date());
  const message = isRecord(line.message) ? line.message : null;

  if (role === "user") {
    const text = extractText(message?.content ?? line.content ?? line.text);
    return { role: "user", text, timestamp };
  }

  if (role === "assistant") {
    const text = extractText(message?.content ?? line.content ?? line.text);
    return { role: "assistant", text, timestamp };
  }

  if (role === "tool_use") {
    const toolName =
      getString(line.toolName) ??
      getString(line.name) ??
      getString(message?.toolName) ??
      getString(message?.name) ??
      undefined;
    const text = stringifyUnknown(line.input ?? message?.input ?? message?.content ?? line.content);
    return { role: "tool_use", text, toolName, timestamp };
  }

  if (role === "tool_result") {
    const toolName =
      getString(line.toolName) ??
      getString(line.name) ??
      getString(message?.toolName) ??
      getString(message?.name) ??
      undefined;
    const text = stringifyUnknown(line.output ?? message?.output ?? message?.content ?? line.content);
    return { role: "tool_result", text, toolName, timestamp };
  }

  return null;
};

const parseCompactions = (lines: JsonRecord[]): CompactionInfo[] => {
  return lines
    .filter((line) => line.isReplay === true && getString(line.type) === "local-command-stdout")
    .map((line) => ({
      timestamp: readSessionTimestamp(line, new Date()),
      summary: extractText(line.message ?? line.content ?? line.text) || "Session compacted.",
      tokensBefore: 0
    }))
    .filter((entry) => entry.summary.toLowerCase().includes("compact"));
};

const loadHistoryResponse = async (sessionId: string | null): Promise<HistoryResponse> => {
  if (!sessionId || !(await sessionFileExists(sessionId))) {
    return { messages: [], preCompactionMessages: [], compactions: [] };
  }

  const lines = await readJsonLines(getSessionFilePath(sessionId));
  return {
    messages: lines.map(parseHistoryMessage).filter((message): message is HistoryMessage => message !== null),
    preCompactionMessages: [],
    compactions: parseCompactions(lines)
  };
};

const loadSessions = async (): Promise<SessionListResponse> => {
  if (!(await fileExists(CLAUDE_PROJECTS_DIR))) {
    return { current: currentSessionId ?? "", sessions: [] };
  }

  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const sessions: SessionInfo[] = [];

  for (const entry of sessionFiles) {
    const fullPath = join(CLAUDE_PROJECTS_DIR, entry);
    const stats = await stat(fullPath);
    const lines = await readJsonLines(fullPath).catch(() => []);
    const createdAt = readSessionTimestamp(lines[0], stats.birthtime);
    sessions.push({
      id: basename(entry, ".jsonl"),
      name: null,
      path: fullPath,
      createdAt,
      lastActiveAt: stats.mtime.toISOString()
    });
  }

  return {
    current: currentSessionId ?? "",
    sessions
  };
};

const loadStatsFromSessionFile = async (sessionId: string | null): Promise<GhostStats> => {
  if (!sessionId || !(await sessionFileExists(sessionId))) {
    return {
      sessionId: sessionId ?? "",
      model: currentModel,
      tokens: 0,
      cost: 0,
      messageCount: 0,
      context: null
    };
  }

  const lines = await readJsonLines(getSessionFilePath(sessionId));
  const history = lines.map(parseHistoryMessage).filter((message): message is HistoryMessage => message !== null);
  const resultLine = [...lines].reverse().find((line) => getString(line.type) === "result");
  const usageRecord = isRecord(resultLine?.usage) ? resultLine.usage : null;
  const inputTokens =
    getNumber(usageRecord?.input_tokens) ??
    getNumber(usageRecord?.inputTokens) ??
    getNumber(usageRecord?.prompt_tokens) ??
    0;
  const outputTokens =
    getNumber(usageRecord?.output_tokens) ??
    getNumber(usageRecord?.outputTokens) ??
    getNumber(usageRecord?.completion_tokens) ??
    0;
  const totalTokens = getNumber(usageRecord?.total_tokens) ?? inputTokens + outputTokens;
  const cost = getNumber(resultLine?.total_cost_usd) ?? 0;

  return {
    sessionId,
    model: currentModel,
    tokens: totalTokens,
    cost,
    messageCount: history.length,
    context: null
  };
};

const parseSlashPrompt = (prompt: string): { command: string; args: string } | null => {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const command = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim().toLowerCase();
  if (!command) {
    return null;
  }

  return {
    command,
    args: spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim()
  };
};

const getEventName = (line: JsonRecord): string => {
  const type = getString(line.type);
  const subtype = getString(line.subtype);
  if (type && subtype) {
    return `${type}/${subtype}`;
  }
  return type ?? "";
};

const getStreamEvent = (line: JsonRecord): JsonRecord | null => {
  const candidates = [line.stream_event, line.event, line.payload];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
};

const extractSessionId = (line: JsonRecord): string | null => {
  const candidates = [
    line.session_id,
    line.sessionId,
    isRecord(line.data) ? line.data.session_id : null,
    isRecord(line.data) ? line.data.sessionId : null
  ];

  for (const candidate of candidates) {
    const sessionId = getString(candidate);
    if (sessionId) {
      return sessionId;
    }
  }

  return null;
};

const extractAssistantFallback = (line: JsonRecord): string => {
  const message = isRecord(line.message) ? line.message : null;
  return (
    extractText(line.text) ||
    extractText(line.content) ||
    extractText(message?.content) ||
    extractText(message?.text) ||
    ""
  );
};

const parseToolInput = (state: StreamState): unknown => {
  if (state.currentToolInputBuffer.trim().length > 0) {
    try {
      return JSON.parse(state.currentToolInputBuffer) as unknown;
    } catch {
      return state.currentToolInputBuffer;
    }
  }

  return state.currentToolInputValue ?? null;
};

const emitTextBlockIfNeeded = (res: ServerResponse, state: StreamState): void => {
  if (state.currentBlockType !== "text") {
    return;
  }

  if (state.textBuffer.trim().length === 0) {
    state.textBuffer = "";
    state.emittedAssistantForBlock = false;
    return;
  }

  sendJsonLine(res, { type: "assistant", text: state.textBuffer });
  state.lastAssistantText = state.textBuffer;
  state.assistantFallback = state.textBuffer;
  state.textBuffer = "";
  state.emittedAssistantForBlock = true;
};

const emitToolUseIfNeeded = (res: ServerResponse, state: StreamState): void => {
  if (state.currentBlockType !== "tool_use" || !state.currentToolName) {
    return;
  }

  sendJsonLine(res, {
    type: "tool_use",
    tool: state.currentToolName,
    input: parseToolInput(state)
  });

  state.currentToolName = null;
  state.currentToolInputBuffer = "";
  state.currentToolInputValue = null;
};

const resetCurrentBlock = (state: StreamState): void => {
  state.currentBlockType = null;
  state.emittedAssistantForBlock = false;
};

const createStreamState = (): StreamState => ({
  textBuffer: "",
  lastAssistantText: "",
  assistantFallback: "",
  thinkingBuffer: "",
  currentBlockType: null,
  currentToolName: null,
  currentToolInputBuffer: "",
  currentToolInputValue: null,
  emittedAssistantForBlock: false
});

const applyResultUsage = (line: JsonRecord): void => {
  const usageRecord = isRecord(line.usage) ? line.usage : null;
  const inputTokens =
    getNumber(usageRecord?.input_tokens) ??
    getNumber(usageRecord?.inputTokens) ??
    getNumber(usageRecord?.prompt_tokens) ??
    0;
  const outputTokens =
    getNumber(usageRecord?.output_tokens) ??
    getNumber(usageRecord?.outputTokens) ??
    getNumber(usageRecord?.completion_tokens) ??
    0;
  const totalTokens = getNumber(usageRecord?.total_tokens) ?? inputTokens + outputTokens;
  const cost = getNumber(line.total_cost_usd) ?? 0;

  latestStats = {
    sessionId: currentSessionId ?? "",
    model: currentModel,
    tokens: totalTokens,
    cost,
    messageCount: latestStats?.messageCount ?? 0,
    context: null,
    updatedAt: new Date().toISOString()
  };
};

const handleClaudeStreamLine = (res: ServerResponse, line: JsonRecord, state: StreamState): void => {
  const eventName = getEventName(line);
  const sessionId = extractSessionId(line);
  if (sessionId) {
    currentSessionId = sessionId;
  }

  if (eventName === "system/init") {
    return;
  }

  if (eventName === "assistant") {
    const fallback = extractAssistantFallback(line);
    if (fallback) {
      state.assistantFallback = fallback;
    }
    return;
  }

  if (eventName === "result") {
    if (!state.lastAssistantText && state.assistantFallback) {
      sendJsonLine(res, { type: "assistant", text: state.assistantFallback });
      state.lastAssistantText = state.assistantFallback;
    }

    applyResultUsage(line);
    sendJsonLine(res, {
      type: "result",
      text: state.lastAssistantText || state.assistantFallback,
      sessionId: currentSessionId ?? ""
    });
    return;
  }

  if (eventName !== "stream_event") {
    return;
  }

  const streamEvent = getStreamEvent(line);
  if (!streamEvent) {
    return;
  }

  const streamType = getString(streamEvent.type);
  const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
  const contentBlock = isRecord(streamEvent.content_block) ? streamEvent.content_block : null;

  if (streamType === "content_block_start") {
    const blockType = getString(contentBlock?.type);

    if (blockType === "text") {
      state.currentBlockType = "text";
      state.textBuffer = "";
      state.emittedAssistantForBlock = false;
      return;
    }

    if (blockType === "thinking") {
      state.currentBlockType = "thinking";
      state.thinkingBuffer = "";
      return;
    }

    if (blockType === "tool_use") {
      state.currentBlockType = "tool_use";
      state.currentToolName = getString(contentBlock?.name);
      state.currentToolInputBuffer = "";
      state.currentToolInputValue = contentBlock?.input ?? null;
      return;
    }
  }

  if (streamType === "content_block_delta") {
    const deltaType = getString(delta?.type);

    if (deltaType === "text_delta" && typeof delta?.text === "string") {
      state.textBuffer += delta.text;
      return;
    }

    if (deltaType === "thinking_delta" && typeof delta?.thinking === "string") {
      state.thinkingBuffer += delta.thinking;
      sendJsonLine(res, { type: "thinking", text: state.thinkingBuffer });
      return;
    }

    if (deltaType === "thinking_delta" && typeof delta?.text === "string") {
      state.thinkingBuffer += delta.text;
      sendJsonLine(res, { type: "thinking", text: state.thinkingBuffer });
      return;
    }

    if (deltaType === "input_json_delta" && typeof delta?.partial_json === "string") {
      state.currentToolInputBuffer += delta.partial_json;
      return;
    }
  }

  if (streamType === "content_block_stop") {
    if (state.currentBlockType === "text") {
      emitTextBlockIfNeeded(res, state);
      resetCurrentBlock(state);
      return;
    }

    if (state.currentBlockType === "tool_use") {
      emitToolUseIfNeeded(res, state);
      resetCurrentBlock(state);
      return;
    }

    if (state.currentBlockType === "thinking") {
      resetCurrentBlock(state);
      state.thinkingBuffer = "";
    }
  }
};

const buildClaudeArgs = async (messages: string[]): Promise<string[]> => {
  await ensureClaudeSupportFiles();

  const args = [
    ...(currentSessionId && (await sessionFileExists(currentSessionId)) ? ["--resume", currentSessionId] : []),
    "--model",
    currentModel,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt-file",
    CLAUDE_APPEND_PROMPT_PATH,
    "--mcp-config",
    CLAUDE_MCP_CONFIG_PATH,
    "--dangerously-skip-permissions"
  ];

  if (messages.length === 0) {
    throw new Error("No user messages to send.");
  }

  return args;
};

const startHeartbeat = (res: ServerResponse): ReturnType<typeof setInterval> => {
  return setInterval(() => {
    sendJsonLine(res, { type: "heartbeat" });
  }, HEARTBEAT_INTERVAL_MS);
};

const clearActiveTurn = (): void => {
  if (activeTurn?.heartbeat) {
    clearInterval(activeTurn.heartbeat);
  }
  activeTurn = null;
};

const spawnClaudeMessage = async (res: ServerResponse, messages: string[]): Promise<void> => {
  const args = await buildClaudeArgs(messages);
  const child = nodeSpawn("claude", args, {
    cwd: "/vault",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const state = createStreamState();
  activeTurn = {
    child,
    heartbeat: startHeartbeat(res),
    buffer: "",
    finished: false,
    pendingResultSessionId: null
  };

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (!activeTurn) {
      return;
    }

    activeTurn.buffer += chunk.toString();
    const lines = activeTurn.buffer.split("\n");
    activeTurn.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as JsonRecord;
        handleClaudeStreamLine(res, parsed, state);
        if (getEventName(parsed) === "result") {
          activeTurn.finished = true;
          if (!res.writableEnded) {
            res.end();
          }
        }
      } catch (error) {
        log("ERROR", "Failed to parse Claude stream line", {
          error: error instanceof Error ? error.message : String(error),
          line: trimmed
        });
      }
    }
  });

  child.on("error", (error) => {
    log("ERROR", "Claude process error", { error: error.message });
    if (!res.writableEnded) {
      sendJsonLine(res, {
        type: "result",
        text: "Ghost server failed while processing message.",
        sessionId: currentSessionId ?? ""
      });
      res.end();
    }
    clearActiveTurn();
  });

  child.on("close", () => {
    const trailingLine = activeTurn?.buffer.trim();
    if (trailingLine) {
      try {
        const parsed = JSON.parse(trailingLine) as JsonRecord;
        handleClaudeStreamLine(res, parsed, state);
      } catch (error) {
        log("ERROR", "Failed to parse trailing Claude stream line", {
          error: error instanceof Error ? error.message : String(error),
          line: trailingLine
        });
      }
    }

    if (activeTurn?.heartbeat) {
      clearInterval(activeTurn.heartbeat);
    }

    if (!res.writableEnded) {
      if (!state.lastAssistantText && state.assistantFallback) {
        sendJsonLine(res, { type: "assistant", text: state.assistantFallback });
      }
      sendJsonLine(res, {
        type: "result",
        text: state.lastAssistantText || state.assistantFallback,
        sessionId: currentSessionId ?? ""
      });
      res.end();
    }

    clearActiveTurn();
  });

  for (const message of messages) {
    child.stdin.write(createUserTurn(message));
  }
  child.stdin.end();
};

const runCompactCommand = async (): Promise<string> => {
  if (!currentSessionId || !(await sessionFileExists(currentSessionId))) {
    throw new Error("No active session to compact.");
  }

  await ensureClaudeSupportFiles();

  return new Promise((resolve, reject) => {
    const args = [
      "--resume",
      currentSessionId,
      "-p",
      "/compact",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "15",
      "--dangerously-skip-permissions",
      "--mcp-config",
      CLAUDE_MCP_CONFIG_PATH
    ];

    const child = nodeSpawn("claude", args, {
      cwd: "/vault",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffer = "";
    let fallback = "";
    let lastText = "";

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const line = JSON.parse(trimmed) as JsonRecord;
          const eventName = getEventName(line);
          const sessionId = extractSessionId(line);
          if (sessionId) {
            currentSessionId = sessionId;
          }

          if (eventName === "assistant") {
            fallback = extractAssistantFallback(line) || fallback;
          }

          if (eventName === "result") {
            applyResultUsage(line);
            lastText = getString(line.text) ?? fallback;
          }
        } catch (error) {
          log("ERROR", "Failed to parse Claude compact line", {
            error: error instanceof Error ? error.message : String(error),
            line: trimmed
          });
        }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const trailingLine = buffer.trim();
      if (trailingLine) {
        try {
          const line = JSON.parse(trailingLine) as JsonRecord;
          const eventName = getEventName(line);
          const sessionId = extractSessionId(line);
          if (sessionId) {
            currentSessionId = sessionId;
          }

          if (eventName === "assistant") {
            fallback = extractAssistantFallback(line) || fallback;
          }

          if (eventName === "result") {
            applyResultUsage(line);
            lastText = getString(line.text) ?? fallback;
          }
        } catch (error) {
          log("ERROR", "Failed to parse trailing Claude compact line", {
            error: error instanceof Error ? error.message : String(error),
            line: trailingLine
          });
        }
      }

      if (code !== 0) {
        reject(new Error(`claude compact failed with exit code ${code ?? 1}.`));
        return;
      }

      resolve(lastText || fallback || "Session compacted.");
    });
  });
};

const listSupportedCommands = (): Array<{ name: string; description: string }> => [
  { name: "/compact", description: "Compact the current session and reduce context." },
  { name: "/new", description: "Start a fresh Claude Code session." },
  { name: "/reload", description: "No-op for Claude Code compatibility." },
  { name: "/help", description: "List available slash commands." }
];

const handleSlashCommand = async (
  res: ServerResponse,
  prompt: string
): Promise<boolean> => {
  const slash = parseSlashPrompt(prompt);
  if (!slash) {
    return false;
  }

  startNdjsonResponse(res);

  if (slash.command === "help") {
    sendAssistantResult(
      res,
      listSupportedCommands()
        .map((command) => `${command.name} - ${command.description}`)
        .join("\n"),
      currentSessionId ?? ""
    );
    return true;
  }

  if (slash.command === "reload") {
    sendAssistantResult(res, "Claude Code reload is not needed.", currentSessionId ?? "");
    return true;
  }

  if (slash.command === "new") {
    currentSessionId = null;
    queue.messages = [];
    sendAssistantResult(res, "New session started.", "");
    return true;
  }

  if (slash.command === "compact") {
    try {
      const summary = await runCompactCommand();
      sendAssistantResult(res, summary, currentSessionId ?? "");
    } catch (error) {
      sendAssistantResult(res, error instanceof Error ? error.message : "Compaction failed.", currentSessionId ?? "");
    }
    return true;
  }

  sendAssistantResult(res, `Unknown command: /${slash.command}`, currentSessionId ?? "");
  return true;
};

let currentSessionId: string | null = null;
let currentModel = getInitialModel();
let activeTurn: ActiveTurn | null = null;
const queue: QueueState = { messages: [] };
let latestStats: ClaudeStatsSnapshot | null = null;

await ensureClaudeSupportFiles();

const handleMessage = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await parseJsonBodyOrRespond<RequestBodyMessage>(req, res);
  if (body === undefined) {
    return;
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    sendJsonError(res, 400, "Missing prompt");
    return;
  }

  const imageValidation = ensureNoImages(body.images);
  if (imageValidation.error) {
    sendJsonError(res, 400, imageValidation.error);
    return;
  }

  if (typeof body.model === "string" && body.model.trim()) {
    currentModel = stripAnthropicPrefix(body.model.trim());
  }

  if (await handleSlashCommand(res, prompt)) {
    return;
  }

  if (activeTurn) {
    queue.messages.push(prompt);
    sendJsonError(res, 409, "Active turn in progress.", {
      queued: true,
      pendingCount: queue.messages.length
    });
    return;
  }

  const queuedMessages = [...queue.messages];
  queue.messages = [];
  startNdjsonResponse(res);
  await spawnClaudeMessage(res, [prompt, ...queuedMessages]);
};

const handleSteer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await parseJsonBodyOrRespond<RequestBodySteer>(req, res);
  if (body === undefined) {
    return;
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    sendJsonError(res, 400, "Missing prompt");
    return;
  }

  const imageValidation = ensureNoImages(body.images);
  if (imageValidation.error) {
    sendJsonError(res, 400, imageValidation.error);
    return;
  }

  if (!activeTurn) {
    sendJsonError(res, 400, "no active turn to steer");
    return;
  }

  activeTurn.child.stdin.write(createUserTurn(prompt));
  sendJson(res, 200, { status: "queued", pendingCount: queue.messages.length });
};

const handleQueue = (res: ServerResponse): void => {
  const response: GhostQueueState = {
    steering: [],
    followUp: [...queue.messages],
    pendingCount: queue.messages.length
  };
  sendJson(res, 200, response);
};

const handleClearQueue = (res: ServerResponse): void => {
  const response: GhostQueueClearResponse = {
    cleared: {
      steering: [],
      followUp: [...queue.messages]
    }
  };
  queue.messages = [];
  sendJson(res, 200, response);
};

const handleHistory = async (res: ServerResponse): Promise<void> => {
  sendJson(res, 200, await loadHistoryResponse(currentSessionId));
};

const handleSessions = async (res: ServerResponse): Promise<void> => {
  sendJson(res, 200, await loadSessions());
};

const handleStats = async (res: ServerResponse): Promise<void> => {
  const baseStats = latestStats ? { ...latestStats } : await loadStatsFromSessionFile(currentSessionId);

  if (currentSessionId && (await sessionFileExists(currentSessionId))) {
    const history = await loadHistoryResponse(currentSessionId);
    baseStats.messageCount = history.messages.length;
  }

  sendJson(res, 200, {
    sessionId: baseStats.sessionId,
    model: baseStats.model,
    tokens: baseStats.tokens,
    cost: baseStats.cost,
    messageCount: baseStats.messageCount,
    context: baseStats.context
  } satisfies GhostStats);
};

const handleCompact = async (res: ServerResponse): Promise<void> => {
  if (activeTurn) {
    sendJsonError(res, 409, "Active turn in progress.");
    return;
  }

  const summary = await runCompactCommand();
  sendJson(res, 200, { status: "compacted", summary });
};

const handleNew = (res: ServerResponse): void => {
  currentSessionId = null;
  queue.messages = [];
  latestStats = null;
  sendJson(res, 200, { status: "new_session", sessionId: "" });
};

const handleAbort = (res: ServerResponse): void => {
  if (activeTurn) {
    activeTurn.child.kill("SIGTERM");
  }
  sendJson(res, 200, { status: "aborted" });
};

const handleTaskKill = (res: ServerResponse): void => {
  sendJson(res, 501, { error: "Background task killing is not supported by the claude-code adapter." });
};

const handleReload = (res: ServerResponse): void => {
  sendJson(res, 200, { status: "reloaded", warning: "No-op for claude-code adapter." });
};

const handleSwitchSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await parseJsonBodyOrRespond<RequestBodySessionSwitch>(req, res);
  if (body === undefined) {
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }

  if (!(await sessionFileExists(sessionId))) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }

  currentSessionId = sessionId;
  sendJson(res, 200, { status: "switched", sessionId });
};

const handleRenameSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await parseJsonBodyOrRespond<RequestBodySessionRename>(req, res);
  if (body === undefined) {
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }

  if (!name) {
    sendJsonError(res, 400, "Missing name");
    return;
  }

  const sourcePath = getSessionFilePath(sessionId);
  if (!(await fileExists(sourcePath))) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }

  const sanitizedName = name.replace(/[\\/]/g, "-");
  const targetPath = getSessionFilePath(sanitizedName);

  await rename(sourcePath, targetPath);
  if (currentSessionId === sessionId) {
    currentSessionId = sanitizedName;
  }

  sendJson(res, 200, { status: "renamed", sessionId: sanitizedName, name: sanitizedName });
};

const handleDeleteSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const sessionId = req.url?.replace("/sessions/", "").trim() ?? "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }

  if (currentSessionId === sessionId) {
    sendJsonError(res, 409, "Cannot delete the active session");
    return;
  }

  const targetPath = getSessionFilePath(sessionId);
  if (!(await fileExists(targetPath))) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }

  await unlink(targetPath);
  sendJson(res, 200, { status: "deleted", sessionId });
};

const handleSchedules = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!GHOSTBOX_GHOST_NAME) {
    sendJsonError(res, 500, "GHOSTBOX_GHOST_NAME is not configured.");
    return;
  }

  const basePath = `/api/ghosts/${encodeURIComponent(GHOSTBOX_GHOST_NAME)}/schedules`;

  if (req.method === "GET") {
    sendJson(res, 200, await hostRequest("GET", basePath));
    return;
  }

  if (req.method === "POST") {
    const body = await parseJsonBodyOrRespond<ScheduleBody>(req, res);
    if (body === undefined) {
      return;
    }

    sendJson(
      res,
      201,
      await hostRequest("POST", basePath, {
        ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
        ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
        ...(typeof body.once === "boolean" ? { once: body.once } : {}),
        ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {})
      })
    );
    return;
  }

  if (req.method === "DELETE") {
    const scheduleId = req.url?.replace("/schedules/", "").trim() ?? "";
    if (!scheduleId) {
      sendJsonError(res, 400, "Missing schedule id");
      return;
    }

    sendJson(res, 200, await hostRequest("DELETE", `${basePath}/${encodeURIComponent(scheduleId)}`));
    return;
  }

  sendJsonError(res, 405, "Method not allowed");
};

const handleNudgeStatus = (res: ServerResponse): void => {
  sendJson(res, 200, { supported: false, status: "unsupported" });
};

const handleNudge = (res: ServerResponse): void => {
  sendJson(res, 200, { ok: true, warning: "Nudges are not supported by the claude-code adapter." });
};

const handleCommands = (res: ServerResponse): void => {
  sendJson(res, 200, listSupportedCommands());
};

const authenticateRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
  if (configuredApiKeys.length === 0) {
    return true;
  }

  const authorization = req.headers.authorization;
  const bearerToken =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

  if (!bearerToken || !configuredApiKeys.includes(bearerToken)) {
    sendJsonError(res, 401, "Unauthorized");
    return false;
  }

  return true;
};

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  log("INFO", "Request received", { method: req.method ?? "", url: req.url ?? "" });

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (!authenticateRequest(req, res)) {
    return;
  }

  if (req.method === "POST" && req.url === "/message") {
    await handleMessage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/steer") {
    await handleSteer(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/queue") {
    handleQueue(res);
    return;
  }

  if (req.method === "POST" && req.url === "/clear-queue") {
    handleClearQueue(res);
    return;
  }

  if (req.method === "GET" && req.url === "/history") {
    await handleHistory(res);
    return;
  }

  if (req.method === "GET" && req.url === "/sessions") {
    await handleSessions(res);
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    await handleStats(res);
    return;
  }

  if (
    (req.method === "GET" && req.url === "/schedules") ||
    (req.method === "POST" && req.url === "/schedules") ||
    (req.method === "DELETE" && req.url?.startsWith("/schedules/"))
  ) {
    await handleSchedules(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/compact") {
    await handleCompact(res);
    return;
  }

  if (req.method === "POST" && req.url === "/new") {
    handleNew(res);
    return;
  }

  if (req.method === "POST" && req.url === "/abort") {
    handleAbort(res);
    return;
  }

  if (req.method === "POST" && req.url === "/reload") {
    handleReload(res);
    return;
  }

  if (req.method === "POST" && req.url === "/sessions/switch") {
    await handleSwitchSession(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/sessions/rename") {
    await handleRenameSession(req, res);
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/sessions/")) {
    await handleDeleteSession(req, res);
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/tasks/")) {
    handleTaskKill(res);
    return;
  }

  if (req.method === "GET" && req.url === "/nudge/status") {
    handleNudgeStatus(res);
    return;
  }

  if (req.method === "POST" && req.url === "/nudge") {
    handleNudge(res);
    return;
  }

  if (req.method === "GET" && req.url === "/commands") {
    handleCommands(res);
    return;
  }

  sendJsonError(res, 404, "Not found");
};

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log("ERROR", "Request handling failed", {
      error: error instanceof Error ? error.message : String(error),
      method: req.method ?? "",
      url: req.url ?? ""
    });

    if (!res.writableEnded) {
      sendJsonError(res, 500, error instanceof Error ? error.message : "Internal server error");
    }
  });
});

server.listen(3000, () => {
  log("INFO", "Claude ghost server listening on port 3000", {
    model: currentModel,
    hasSession: existsSync(currentSessionId ? getSessionFilePath(currentSessionId) : "")
  });
});
