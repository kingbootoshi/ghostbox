import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  CompactionInfo,
  GhostImage,
  GhostMessage,
  GhostQueueClearResponse,
  GhostQueueState,
  GhostRuntimeCapability,
  GhostRuntimeMeta,
  GhostSchedule,
  GhostStats,
  HistoryMessage,
  SessionInfo,
  SessionListResponse,
  TimelineItem,
  TimelineResponse
} from "../src/types";

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || "/vault/.claude";
const CLAUDE_PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, "projects", "-vault");
const CLAUDE_MCP_CONFIG_PATH = join(CLAUDE_CONFIG_DIR, ".mcp.json");
const CLAUDE_APPEND_PROMPT_PATH = join(CLAUDE_CONFIG_DIR, "ghostbox-system-prompt.md");
const SESSION_NAMES_PATH = join(CLAUDE_CONFIG_DIR, "session-names.json");
const GHOSTBOX_SKILL_PATH = "/opt/ghostbox/skills/ghostbox-api/SKILL.md";
const GHOSTBOX_API_PORT = process.env.GHOSTBOX_API_PORT || "8008";
const GHOSTBOX_HOST_BASE = `http://host.docker.internal:${GHOSTBOX_API_PORT}`;
const GHOSTBOX_GHOST_NAME = process.env.GHOSTBOX_GHOST_NAME || "";
const GHOSTBOX_IMAGE_VERSION = process.env.GHOSTBOX_IMAGE_VERSION?.trim() || null;
const MEMORY_PATH = "/vault/MEMORY.md";
const USER_PATH = "/vault/USER.md";
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const SNAPSHOT_SUFFIX = ".snapshot.txt";
const FLUSH_MEMORY_TIMEOUT_MS = 60_000;
const DISALLOWED_NATIVE_TOOLS =
  "ScheduleWakeup CronCreate CronList CronDelete RemoteTrigger PushNotification";
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const defaultSystemPrompt =
  'You are a ghost agent. Your vault at /vault is your persistent memory. Use memory_write to save facts (target "memory" for notes, target "user" for user profile). Use memory_show to check your current memory. Use `qmd` to search and read vault files on demand. Before responding to complex questions, check your memory and vault first. Write findings to /vault/knowledge/. Create tools in /vault/.pi/extensions/. Everything in /vault persists across sessions. The rest of the filesystem is throwaway.';
const memoryCharLimit = 4000;
const userCharLimit = 2000;
const runtimeVersion = `node/${process.version}`;
const CLAUDE_SUPPORTED_CAPABILITIES: GhostRuntimeCapability[] = [
  "message",
  "steer",
  "queue",
  "timeline",
  "sessions",
  "stats",
  "commands",
  "compact",
  "newSession",
  "abort",
  "schedules"
];

type UserTurn = {
  text: string;
  images: GhostImage[];
};

type JsonRecord = Record<string, unknown>;

type QueueState = {
  messages: UserTurn[];
};

type NudgeEvent = "pre-compact" | "pre-new-session" | "message-complete";

type NudgeHandler = (event: NudgeEvent, reason: string) => Promise<void> | void;

type StreamState = {
  textBuffer: string;
  lastAssistantText: string;
  assistantFallback: string;
  receivedResultEvent: boolean;
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
  snapshotPrompt: string;
  snapshotPersisted: boolean;
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

class NudgeRegistry {
  #handlers = new Map<NudgeEvent, NudgeHandler[]>();

  register(event: NudgeEvent, handler: NudgeHandler): void {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
  }

  async emit(event: NudgeEvent, reason: string): Promise<void> {
    const handlers = this.#handlers.get(event) ?? [];
    for (const handler of handlers) {
      await handler(event, reason);
    }
  }
}

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
const nudges = new NudgeRegistry();

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

const parseRequestImages = (imagesValue: unknown): { images: GhostImage[]; error?: string } => {
  if (imagesValue === undefined) {
    return { images: [] };
  }

  if (!Array.isArray(imagesValue)) {
    return { images: [], error: "Invalid images" };
  }

  const images: GhostImage[] = [];

  for (const imageValue of imagesValue) {
    if (!isRecord(imageValue) || typeof imageValue.mediaType !== "string" || typeof imageValue.data !== "string") {
      return { images: [], error: "Invalid images" };
    }

    if (!SUPPORTED_IMAGE_TYPES.has(imageValue.mediaType)) {
      return { images: [], error: `Unsupported image type: ${imageValue.mediaType}` };
    }

    images.push({
      mediaType: imageValue.mediaType,
      data: imageValue.data
    });
  }

  return { images };
};

const validateSessionId = (sessionId: string): boolean => {
  return SESSION_ID_PATTERN.test(sessionId);
};

const validateSessionName = (name: string): boolean => {
  return name.length >= 1 && name.length <= 80 && SESSION_NAME_PATTERN.test(name);
};

const getSessionFilePath = (sessionId: string): string => {
  return join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`);
};

const getSnapshotPath = (sessionId: string): string => {
  return join(CLAUDE_PROJECTS_DIR, `${sessionId}${SNAPSHOT_SUFFIX}`);
};

const readJsonLines = async (path: string): Promise<JsonRecord[]> => {
  const content = await readFile(path, "utf8");
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parsedLines: JsonRecord[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      parsedLines.push(JSON.parse(line) as JsonRecord);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      if (index < lines.length - 1) {
        log("ERROR", "Failed to parse JSONL line", {
          path,
          error: error.message,
          line
        });
      }
    }
  }

  return parsedLines;
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

const renderMemoryBlock = (label: string, content: string, limit: number): string => {
  if (!content) {
    return "";
  }

  const pct = Math.round((content.length / limit) * 100);
  const separator = "=".repeat(50);
  return `${separator}\n${label} [${pct}% - ${content.length}/${limit} chars]\n${separator}\n${content}`;
};

const getBaseSystemPrompt = (): string => {
  return process.env.GHOSTBOX_SYSTEM_PROMPT?.trim() || defaultSystemPrompt;
};

const buildMemoryBlocks = async (): Promise<string> => {
  const memoryContent = (await readFileText(MEMORY_PATH)).trim();
  const userContent = (await readFileText(USER_PATH)).trim();
  const blocks: string[] = [];

  if (memoryContent) {
    blocks.push(renderMemoryBlock("MEMORY (your personal notes)", memoryContent, memoryCharLimit));
  }

  if (userContent) {
    blocks.push(renderMemoryBlock("USER PROFILE (who the user is)", userContent, userCharLimit));
  }

  return blocks.join("\n\n");
};

const buildStaticAppendSystemPrompt = async (): Promise<string> => {
  const skillText = (await readFileText(GHOSTBOX_SKILL_PATH)).trim();
  return `${[getBaseSystemPrompt(), skillText].filter((part) => part.length > 0).join("\n\n")}\n`;
};

const buildSessionSnapshot = async (): Promise<string> => {
  const staticPrompt = await readFileText(CLAUDE_APPEND_PROMPT_PATH);
  const memoryBlocks = await buildMemoryBlocks();
  return memoryBlocks.length > 0 ? `${staticPrompt.trimEnd()}\n\n${memoryBlocks}` : staticPrompt;
};

const persistSessionSnapshot = async (sessionId: string, snapshot: string): Promise<void> => {
  await writeFile(getSnapshotPath(sessionId), snapshot, { encoding: "utf8", mode: 0o600 });
};

const ensureSessionSnapshot = async (sessionId: string | null): Promise<string> => {
  if (sessionId) {
    const snapshotPath = getSnapshotPath(sessionId);
    if (await fileExists(snapshotPath)) {
      return await readFile(snapshotPath, "utf8");
    }

    const snapshot = await buildSessionSnapshot();
    await persistSessionSnapshot(sessionId, snapshot);
    return snapshot;
  }

  return await buildSessionSnapshot();
};

const rebuildSessionSnapshot = async (sessionId: string | null): Promise<string> => {
  const snapshot = await buildSessionSnapshot();
  if (sessionId) {
    await persistSessionSnapshot(sessionId, snapshot);
  }
  return snapshot;
};

const clearSessionSnapshot = async (sessionId: string | null): Promise<void> => {
  if (!sessionId) {
    return;
  }

  await unlink(getSnapshotPath(sessionId)).catch(() => {});
};

const readSessionNames = async (): Promise<Record<string, string>> => {
  try {
    const raw = await readFile(SESSION_NAMES_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([sessionId, name]) => validateSessionId(sessionId) && typeof name === "string" && validateSessionName(name)
      )
    );
  } catch {
    return {};
  }
};

const writeSessionNames = async (records: Record<string, string>): Promise<void> => {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${SESSION_NAMES_PATH}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, SESSION_NAMES_PATH);
};

const ensureClaudeSupportFiles = async (): Promise<void> => {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await mkdir(CLAUDE_PROJECTS_DIR, { recursive: true, mode: 0o700 });

  const baselinePrompt = await buildStaticAppendSystemPrompt();
  if ((await readFileText(CLAUDE_APPEND_PROMPT_PATH)) !== baselinePrompt) {
    await writeFile(CLAUDE_APPEND_PROMPT_PATH, baselinePrompt, { encoding: "utf8", mode: 0o600 });
  }

  if (!(await fileExists(CLAUDE_MCP_CONFIG_PATH))) {
    const payload = {
      mcpServers: {
        ghostbox: {
          command: "node",
          args: ["/ghostbox-mcp-server.js"]
        },
        exa: {
          type: "http",
          url: "https://mcp.exa.ai/mcp"
        },
        qmd: {
          command: "node",
          args: ["/qmd-mcp-server.js"]
        }
      }
    };
    await writeFile(CLAUDE_MCP_CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
};

const createUserTurn = (text: string, images: GhostImage[] = []): string => {
  const content =
    images.length > 0
      ? [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mediaType,
              data: image.data
            }
          })),
          {
            type: "text" as const,
            text
          }
        ]
      : text;

  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
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

const parseCompaction = (line: JsonRecord): CompactionInfo | null => {
  if (!(line.isReplay === true && getString(line.type) === "local-command-stdout")) {
    return null;
  }

  const summary = extractText(line.message ?? line.content ?? line.text) || "Session compacted.";
  if (!summary.toLowerCase().includes("compact")) {
    return null;
  }

  return {
    timestamp: readSessionTimestamp(line, new Date()),
    summary,
    tokensBefore: 0
  };
};

const encodeTimelineCursor = (index: number): string => Buffer.from(`idx:${index}`, "utf8").toString("base64");

const decodeTimelineCursor = (cursor: string): number => {
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const match = /^idx:(\d+)$/.exec(decoded);

  if (!match) {
    throw new Error("Invalid timeline cursor");
  }

  const index = Number(match[1]);
  if (!Number.isSafeInteger(index)) {
    throw new Error("Invalid timeline cursor");
  }

  return index;
};

const paginateTimelineItems = (
  items: TimelineItem[],
  cursor: string | undefined,
  limit: number | undefined
): TimelineResponse => {
  const totalCount = items.length;
  const before = cursor === undefined ? undefined : decodeTimelineCursor(cursor);
  const boundedBefore = before === undefined ? totalCount : Math.max(0, Math.min(before, totalCount));
  const boundedLimit = limit === undefined ? totalCount : Math.max(1, Math.min(limit, 200));
  const startIndex = Math.max(0, boundedBefore - boundedLimit);

  return {
    items: items.slice(startIndex, boundedBefore),
    totalCount,
    nextCursor: startIndex > 0 ? encodeTimelineCursor(startIndex) : null
  };
};

const parseTimelineRequest = (
  req: IncomingMessage
): { cursor: string | undefined; limit: number | undefined } => {
  const url = new URL(req.url ?? "/timeline", "http://localhost");
  const limitValue = url.searchParams.get("limit");
  const cursorValue = url.searchParams.get("cursor");
  const limit = limitValue === null ? undefined : Number(limitValue);

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("Invalid timeline limit");
  }

  return { cursor: cursorValue === null ? undefined : cursorValue, limit };
};

const loadTimelineItems = async (sessionId: string | null): Promise<TimelineItem[]> => {
  if (!sessionId || !(await sessionFileExists(sessionId))) {
    return [];
  }

  const lines = await readJsonLines(getSessionFilePath(sessionId));
  const items: TimelineItem[] = [];

  lines.forEach((line, index) => {
    const compaction = parseCompaction(line);
    if (compaction) {
      items.push({
        id: `compaction:${index}`,
        type: "compaction",
        compaction
      });
      return;
    }

    const message = parseHistoryMessage(line);
    if (message === null) {
      return;
    }

    items.push({
      id: `message:${index}`,
      type: "message",
      message
    });
  });

  return items;
};

const loadSessions = async (): Promise<SessionListResponse> => {
  if (!(await fileExists(CLAUDE_PROJECTS_DIR))) {
    return { current: currentSessionId ?? "", sessions: [] };
  }

  const sessionNames = await readSessionNames();
  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const sessions: SessionInfo[] = [];

  for (const entry of sessionFiles) {
    const fullPath = join(CLAUDE_PROJECTS_DIR, entry);
    const stats = await stat(fullPath);
    const lines = await readJsonLines(fullPath).catch(() => []);
    const sessionId = basename(entry, ".jsonl");
    const createdAt = readSessionTimestamp(lines[0], stats.birthtime);
    sessions.push({
      id: sessionId,
      name: sessionNames[sessionId] ?? null,
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

  if (state.emittedAssistantForBlock) {
    state.lastAssistantText = state.assistantFallback || state.lastAssistantText;
    state.textBuffer = "";
    state.emittedAssistantForBlock = false;
    return;
  }

  if (state.textBuffer.trim().length === 0) {
    state.textBuffer = "";
    return;
  }

  sendJsonLine(res, { type: "assistant", text: state.textBuffer });
  state.lastAssistantText = state.textBuffer;
  state.assistantFallback = state.textBuffer;
  state.textBuffer = "";
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
  receivedResultEvent: false,
  thinkingBuffer: "",
  currentBlockType: null,
  currentToolName: null,
  currentToolInputBuffer: "",
  currentToolInputValue: null,
  emittedAssistantForBlock: false
});

const persistPendingSessionSnapshot = async (sessionId: string | null): Promise<void> => {
  const turn = activeTurn;
  if (!turn || turn.snapshotPersisted || !sessionId) {
    return;
  }

  await persistSessionSnapshot(sessionId, turn.snapshotPrompt);
  turn.snapshotPersisted = true;
};

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
    void persistPendingSessionSnapshot(sessionId).catch((error) => {
      log("ERROR", "Failed to persist session snapshot", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
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

  if (eventName === "user") {
    const messageRecord = isRecord(line.message) ? line.message : null;
    const content = messageRecord?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || getString(block.type) !== "tool_result") {
          continue;
        }
        const output = extractText(block.content) || extractText(block.text) || "";
        if (!output) {
          continue;
        }
        sendJsonLine(res, { type: "tool_result", output });
      }
    }
    return;
  }

  if (eventName === "result") {
    state.receivedResultEvent = true;
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
      if (delta.text.length === 0) {
        return;
      }
      sendJsonLine(res, { type: "assistant", text: delta.text });
      state.textBuffer += delta.text;
      state.assistantFallback = state.textBuffer;
      state.lastAssistantText = state.textBuffer;
      state.emittedAssistantForBlock = true;
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

const buildClaudeArgs = async (
  messages: UserTurn[]
): Promise<{ args: string[]; snapshotPrompt: string; snapshotPersisted: boolean }> => {
  await ensureClaudeSupportFiles();
  const resumeSessionId = currentSessionId && (await sessionFileExists(currentSessionId)) ? currentSessionId : null;
  const snapshotPrompt = await ensureSessionSnapshot(resumeSessionId);

  const args = [
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "--model",
    currentModel,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt",
    snapshotPrompt,
    "--mcp-config",
    CLAUDE_MCP_CONFIG_PATH,
    "--disallowedTools",
    DISALLOWED_NATIVE_TOOLS,
    "--dangerously-skip-permissions"
  ];

  if (messages.length === 0) {
    throw new Error("No user messages to send.");
  }

  return {
    args,
    snapshotPrompt,
    snapshotPersisted: resumeSessionId !== null
  };
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

const flushMemories = async (reason: string): Promise<void> => {
  if (!currentSessionId || !(await sessionFileExists(currentSessionId))) {
    return;
  }

  const flushPrompt = `This session is ending (reason: ${reason}). Before context is lost, use mcp__ghostbox__memory_write to save any facts worth remembering: user preferences, important decisions, ongoing work, names and contacts. Skip if nothing notable. Call mcp__ghostbox__memory_show when done to confirm, or just reply done if nothing to save.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_MEMORY_TIMEOUT_MS);
  const claudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const isSandbox = process.env.IS_SANDBOX;
  let timedOut = false;

  timeout.unref?.();
  controller.signal.addEventListener("abort", () => {
    timedOut = true;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn(
        "claude",
        [
          "--resume",
          currentSessionId,
          "-p",
          flushPrompt,
          "--model",
          currentModel,
          "--max-turns",
          "3",
          "--output-format",
          "json",
          "--dangerously-skip-permissions",
          "--mcp-config",
          CLAUDE_MCP_CONFIG_PATH,
          "--disallowedTools",
          DISALLOWED_NATIVE_TOOLS
        ],
        {
          cwd: "/vault",
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR,
            ...(claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken } : {}),
            ...(isSandbox ? { IS_SANDBOX: isSandbox } : {})
          },
          stdio: ["ignore", "pipe", "pipe"],
          signal: controller.signal
        }
      );

      child.stdout.on("data", (chunk: Buffer) => {
        log("INFO", "Memory flush output", {
          reason,
          sessionId: currentSessionId ?? "",
          output: chunk.toString("utf8").trim()
        });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      child.on("error", (error) => {
        if (timedOut || error.name === "AbortError") {
          resolve();
          return;
        }

        reject(error);
      });

      child.on("close", (code) => {
        if (timedOut) {
          resolve();
          return;
        }

        if (code !== 0) {
          reject(new Error(`claude memory flush failed with exit code ${code ?? 1}.`));
          return;
        }

        resolve();
      });
    });
  } catch (error) {
    log("ERROR", "Memory flush failed", {
      reason,
      sessionId: currentSessionId ?? "",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
    if (timedOut) {
      log("ERROR", "Memory flush timed out", {
        reason,
        sessionId: currentSessionId ?? ""
      });
    }
  }
};

const spawnClaudeMessage = async (res: ServerResponse, messages: UserTurn[]): Promise<void> => {
  const { args, snapshotPrompt, snapshotPersisted } = await buildClaudeArgs(messages);
  const child = nodeSpawn("claude", args, {
    cwd: "/vault",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const state = createStreamState();
  const stdoutDecoder = new StringDecoder("utf8");
  // Capture the turn instance locally. Every handler below references `turn`
  // (not the global `activeTurn`) so that if a stale turn's stdout/close
  // handlers fire after a new turn has already been spawned, they cannot
  // corrupt the new turn's state. The global `activeTurn` is only mutated
  // when `activeTurn === turn` (i.e., this turn is still the live one).
  const turn: ActiveTurn = {
    child,
    heartbeat: startHeartbeat(res),
    buffer: "",
    finished: false,
    pendingResultSessionId: null,
    snapshotPrompt,
    snapshotPersisted
  };
  activeTurn = turn;

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    // Drop any data from a turn that is no longer the live turn — its
    // handlers may still be running while a fresh turn owns the stream.
    if (activeTurn !== turn) {
      return;
    }

    turn.buffer += stdoutDecoder.write(chunk);
    const lines = turn.buffer.split("\n");
    turn.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as JsonRecord;
        handleClaudeStreamLine(res, parsed, state);
        if (getEventName(parsed) === "result") {
          void nudges.emit("message-complete", "result").catch((error) => {
            log("ERROR", "Message-complete nudge failed", {
              error: error instanceof Error ? error.message : String(error),
              sessionId: currentSessionId ?? ""
            });
          });
          turn.finished = true;
          if (!res.writableEnded) {
            res.end();
          }
          // Force the claude subprocess to exit so child.on('close') fires and
          // clearActiveTurn() runs. Without this, a claude process that hangs
          // after emitting its result event leaves activeTurn stuck forever,
          // and every subsequent /message silently queues. Observed in
          // production: PID 2156 hung 56h post-result on 2026-04-29.
          try {
            turn.child.kill("SIGTERM");
          } catch {
            // Already dead or kill failed; close handler will still fire.
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
    if (activeTurn === turn) {
      clearActiveTurn();
    }
  });

  child.on("close", async (code) => {
    turn.buffer += stdoutDecoder.end();

    const trailingLine = turn.buffer.trim();
    // Only parse trailing output if this turn is still the live one.
    // A stale turn's trailing buffer could otherwise overwrite the new turn's
    // currentSessionId or stream state via handleClaudeStreamLine.
    if (trailingLine && activeTurn === turn) {
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

    if (activeTurn === turn) {
      await persistPendingSessionSnapshot(currentSessionId).catch((error) => {
        log("ERROR", "Failed to persist final session snapshot", {
          sessionId: currentSessionId ?? "",
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    // Always clear this turn's heartbeat — it belongs to this turn alone.
    if (turn.heartbeat) {
      clearInterval(turn.heartbeat);
    }

    if (activeTurn === turn && !res.writableEnded) {
      if ((code ?? 0) !== 0 && !state.receivedResultEvent) {
        const message = `Claude subprocess exited with code ${code ?? 1}.`;
        log("ERROR", message, { sessionId: currentSessionId ?? "" });
        sendJsonLine(res, {
          type: "result",
          text: message,
          sessionId: currentSessionId ?? ""
        });
        res.end();
        clearActiveTurn();
        return;
      }

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

    if (activeTurn === turn) {
      clearActiveTurn();
    }
  });

  for (const message of messages) {
    child.stdin.write(createUserTurn(message.text, message.images));
  }
  child.stdin.end();
};

const runCompactCommand = async (): Promise<string> => {
  if (!currentSessionId || !(await sessionFileExists(currentSessionId))) {
    throw new Error("No active session to compact.");
  }

  await nudges.emit("pre-compact", "compact");
  await rebuildSessionSnapshot(currentSessionId);
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
      CLAUDE_MCP_CONFIG_PATH,
      "--disallowedTools",
      DISALLOWED_NATIVE_TOOLS
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
    const stdoutDecoder = new StringDecoder("utf8");

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
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
      buffer += stdoutDecoder.end();
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

const listSupportedCommands = (): GhostRuntimeMeta["supportedCommands"] => [
  { name: "/model", description: "Show or switch model: /model <provider/id>" },
  { name: "/compact", description: "Compact the current session and reduce context." },
  { name: "/new", description: "Start a fresh Claude Code session." },
  { name: "/help", description: "List available slash commands." }
];

const getRuntimeMeta = (): GhostRuntimeMeta => ({
  adapter: "claude-code",
  runtimeVersion,
  imageVersion: GHOSTBOX_IMAGE_VERSION,
  supportedCapabilities: [...CLAUDE_SUPPORTED_CAPABILITIES],
  supportedCommands: listSupportedCommands(),
  currentModel,
  currentSessionId: currentSessionId ?? null
});

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

  if (slash.command === "model") {
    const nextModelValue = slash.args.trim();
    if (!nextModelValue) {
      sendAssistantResult(res, `Current model: ${currentModel}`, currentSessionId ?? "");
      return true;
    }
    currentModel = stripAnthropicPrefix(nextModelValue);
    sendAssistantResult(res, `Model switched to ${currentModel}.`, currentSessionId ?? "");
    return true;
  }

  if (slash.command === "reload") {
    sendAssistantResult(res, "Reload is not supported by the claude-code adapter.", currentSessionId ?? "");
    return true;
  }

  if (slash.command === "new") {
    await nudges.emit("pre-new-session", "slash-command");
    await clearSessionSnapshot(currentSessionId);
    currentSessionId = null;
    queue.messages = [];
    latestStats = null;
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
let sessionOpLock = false;
const queue: QueueState = { messages: [] };
let latestStats: ClaudeStatsSnapshot | null = null;

nudges.register("pre-compact", async (_event, reason) => {
  await flushMemories(reason);
});
nudges.register("pre-new-session", async (_event, reason) => {
  await flushMemories(reason);
});

await ensureClaudeSupportFiles();

const recoverMostRecentSession = async (): Promise<void> => {
  if (!(await fileExists(CLAUDE_PROJECTS_DIR))) {
    return;
  }
  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl"));
  if (sessionFiles.length === 0) {
    return;
  }
  let newest: { id: string; mtime: number } | null = null;
  for (const entry of sessionFiles) {
    const stats = await stat(join(CLAUDE_PROJECTS_DIR, entry));
    const mtime = stats.mtime.getTime();
    if (!newest || mtime > newest.mtime) {
      newest = { id: basename(entry, ".jsonl"), mtime };
    }
  }
  if (newest) {
    currentSessionId = newest.id;
  }
};

await recoverMostRecentSession();

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

  const imageParse = parseRequestImages(body.images);
  if (imageParse.error) {
    sendJsonError(res, 400, imageParse.error);
    return;
  }
  const userTurn: UserTurn = { text: prompt, images: imageParse.images };

  if (typeof body.model === "string" && body.model.trim()) {
    currentModel = stripAnthropicPrefix(body.model.trim());
  }

  if (await handleSlashCommand(res, prompt)) {
    return;
  }

  if (sessionOpLock) {
    sendJsonError(res, 409, "Turn in progress, try again.");
    return;
  }

  if (activeTurn) {
    // Defensive: if the prior turn already emitted its result but the child
    // never exited (so close handler never fired), force-clear and proceed.
    // This prevents the silent-queue-forever failure mode we hit on
    // 2026-04-29 when PID 2156 hung post-result.
    if (activeTurn.finished) {
      log("ERROR", "Force-clearing stale activeTurn (finished but child stuck)", {
        sessionId: currentSessionId ?? "",
        childPid: activeTurn.child.pid ?? 0
      });
      try {
        activeTurn.child.kill("SIGKILL");
      } catch {
        // Already dead.
      }
      clearActiveTurn();
    } else {
      log("INFO", "Message queued while turn in progress", {
        sessionId: currentSessionId ?? "",
        queueLength: queue.messages.length + 1,
        childPid: activeTurn.child.pid ?? 0
      });
      queue.messages.push(userTurn);
      startNdjsonResponse(res);
      sendJsonLine(res, {
        type: "result",
        text: "Queued for next turn.",
        sessionId: currentSessionId ?? ""
      });
      res.end();
      return;
    }
  }

  const queuedMessages = [...queue.messages];
  queue.messages = [];
  sessionOpLock = true;

  try {
    startNdjsonResponse(res);
    await spawnClaudeMessage(res, [...queuedMessages, userTurn]);
  } finally {
    sessionOpLock = false;
  }
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

  const imageParse = parseRequestImages(body.images);
  if (imageParse.error) {
    sendJsonError(res, 400, imageParse.error);
    return;
  }

  if (!activeTurn) {
    sendJsonError(res, 400, "no active turn to steer");
    return;
  }

  activeTurn.child.stdin.write(createUserTurn(prompt, imageParse.images));
  sendJson(res, 200, { status: "queued", pendingCount: queue.messages.length });
};

const handleQueue = (res: ServerResponse): void => {
  const response: GhostQueueState = {
    steering: [],
    followUp: queue.messages.map((message) => message.text),
    pendingCount: queue.messages.length
  };
  sendJson(res, 200, response);
};

const handleClearQueue = (res: ServerResponse): void => {
  const response: GhostQueueClearResponse = {
    cleared: {
      steering: [],
      followUp: queue.messages.map((message) => message.text)
    }
  };
  queue.messages = [];
  sendJson(res, 200, response);
};

const handleTimeline = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const timelineRequest = parseTimelineRequest(req);
  const items = await loadTimelineItems(currentSessionId);
  sendJson(res, 200, paginateTimelineItems(items, timelineRequest.cursor, timelineRequest.limit));
};

const handleSessions = async (res: ServerResponse): Promise<void> => {
  sendJson(res, 200, await loadSessions());
};

const handleStats = async (res: ServerResponse): Promise<void> => {
  const baseStats = latestStats ? { ...latestStats } : await loadStatsFromSessionFile(currentSessionId);

  if (currentSessionId && (await sessionFileExists(currentSessionId))) {
    const timeline = await loadTimelineItems(currentSessionId);
    baseStats.messageCount = timeline.filter((item) => item.type === "message").length;
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

const handleNew = async (res: ServerResponse): Promise<void> => {
  await nudges.emit("pre-new-session", "api");
  await clearSessionSnapshot(currentSessionId);
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
  sendJson(res, 501, { error: "Reload is not supported by the claude-code adapter." });
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

  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
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

  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
    return;
  }

  if (!name) {
    sendJsonError(res, 400, "Missing name");
    return;
  }

  if (!validateSessionName(name)) {
    sendJsonError(res, 400, "Invalid session name");
    return;
  }

  const sourcePath = getSessionFilePath(sessionId);
  if (!(await fileExists(sourcePath))) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }

  if (activeTurn || sessionOpLock) {
    sendJsonError(res, 409, "Turn in progress, try again.");
    return;
  }

  sessionOpLock = true;

  try {
    const sessionNames = await readSessionNames();
    if (Object.entries(sessionNames).some(([existingId, existingName]) => existingId !== sessionId && existingName === name)) {
      sendJsonError(res, 409, "A session with that name already exists.");
      return;
    }

    await writeSessionNames({
      ...sessionNames,
      [sessionId]: name
    });
  } finally {
    sessionOpLock = false;
  }

  sendJson(res, 200, { status: "renamed", sessionId, name });
};

const handleDeleteSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const sessionId = req.url?.replace("/sessions/", "").trim() ?? "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }

  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
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
  await clearSessionSnapshot(sessionId);
  const sessionNames = await readSessionNames();
  if (sessionNames[sessionId] !== undefined) {
    delete sessionNames[sessionId];
    await writeSessionNames(sessionNames);
  }
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
  sendJson(res, 501, { error: "Nudge status is not supported by the claude-code adapter." });
};

const handleNudge = (res: ServerResponse): void => {
  sendJson(res, 501, { error: "Nudges are not supported by the claude-code adapter." });
};

const handleCommands = (res: ServerResponse): void => {
  sendJson(res, 200, getRuntimeMeta().supportedCommands);
};

const handleRuntimeMeta = (res: ServerResponse): void => {
  sendJson(res, 200, getRuntimeMeta());
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

  if (req.method === "GET" && req.url?.startsWith("/timeline")) {
    await handleTimeline(req, res);
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
    await handleNew(res);
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

  if (req.method === "GET" && req.url === "/runtime/meta") {
    handleRuntimeMeta(res);
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
