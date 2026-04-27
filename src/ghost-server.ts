import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";

import {
  type AgentSession,
  AuthStorage,
  codingTools,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import { createGhostHandlers } from "./ghost-handlers";
import { createGhostMemory, NUDGE_EVENTS, NudgeRegistry, registerDefaultNudgeHandlers } from "./ghost-memory";
import type {
  GhostImage,
  GhostMessage,
  GhostRuntimeCapability,
  GhostRuntimeMeta,
  GhostSchedule,
  GhostStreamingBehavior,
  HistoryMessage,
  MailboxState,
  MailMessage
} from "./types";

const defaultSystemPrompt =
  'You are a ghost agent. Your vault at /vault is your persistent memory. Use memory_write to save facts (target "memory" for notes, target "user" for user profile). Use memory_show to check your current memory. Use `qmd` to search and read vault files on demand. Before responding to complex questions, check your memory and vault first. Write findings to /vault/knowledge/. Create tools in /vault/.pi/extensions/. Everything in /vault persists across sessions. The rest of the filesystem is throwaway.';

const memoryCharLimit = 4000;
const userCharLimit = 2000;

const readMemoryFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

const renderMemoryBlock = (label: string, content: string, limit: number): string => {
  if (!content) return "";
  const pct = Math.round((content.length / limit) * 100);
  const separator = "=".repeat(50);
  return `${separator}\n${label} [${pct}% - ${content.length}/${limit} chars]\n${separator}\n${content}`;
};

const buildSystemPrompt = (): string => {
  const basePrompt = process.env.GHOSTBOX_SYSTEM_PROMPT || defaultSystemPrompt;

  const memoryContent = readMemoryFile("/vault/MEMORY.md");
  const userContent = readMemoryFile("/vault/USER.md");

  if (!memoryContent && !userContent) {
    return basePrompt;
  }

  const blocks: string[] = [basePrompt, ""];

  if (memoryContent) {
    blocks.push(renderMemoryBlock("MEMORY (your personal notes)", memoryContent, memoryCharLimit));
  }

  if (userContent) {
    blocks.push(renderMemoryBlock("USER PROFILE (who the user is)", userContent, userCharLimit));
  }

  return blocks.join("\n");
};

const hostApiPort = process.env.GHOSTBOX_API_PORT || "8008";
const ghostName = process.env.GHOSTBOX_GHOST_NAME || "";
const ghostApiKey = process.env.GHOST_API_KEY || "";
const imageVersion = process.env.GHOSTBOX_IMAGE_VERSION?.trim() || null;
const runtimeVersion = `node/${process.version}`;

type ScheduleToolParams = {
  action: "create" | "list" | "delete";
  cron?: string;
  prompt?: string;
  id?: string;
  once?: boolean;
  timezone?: string;
};

type ScheduleCreateInput = Pick<ScheduleToolParams, "cron" | "prompt" | "once" | "timezone">;

type MailboxToolParams = {
  action: "check" | "inbox" | "read" | "send" | "reply";
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  priority?: "normal" | "urgent";
};

type MailSendInput = Pick<MailboxToolParams, "to" | "subject" | "body" | "priority">;

const scheduleToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "delete"],
      description: "Whether to create, list, or delete schedules for this ghost."
    },
    cron: {
      type: "string",
      description: "Five-field cron expression. Required when action is create."
    },
    prompt: {
      type: "string",
      description: "Prompt to send when the schedule fires. Required when action is create."
    },
    id: {
      type: "string",
      description: "Schedule id to delete. Required when action is delete."
    },
    once: {
      type: "boolean",
      description: "Set true to disable the schedule after the first time it fires."
    },
    timezone: {
      type: "string",
      description: "IANA timezone like America/Los_Angeles. Defaults to the host timezone."
    }
  },
  required: ["action"]
};

const mailboxToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["check", "inbox", "read", "send", "reply"],
      description:
        "Whether to check unread mail, list the inbox, read a message, send a message, or reply to a message."
    },
    to: {
      type: "string",
      description: "Recipient ghost name or 'user'. Required when action is send."
    },
    subject: {
      type: "string",
      description: "Message subject. Required when action is send."
    },
    body: {
      type: "string",
      description: "Message body. Required when action is send or reply."
    },
    messageId: {
      type: "string",
      description: "Message id to read or reply to. Required when action is read or reply."
    },
    priority: {
      type: "string",
      enum: ["normal", "urgent"],
      description: "Message priority. Optional and defaults to normal.",
      default: "normal"
    }
  },
  required: ["action"]
};

const settingsPath = "/root/.pi/agent/settings.json";
const defaultModelContextWindow = 200000;
const defaultReserveTokens = 16384;
const keepRecentTokens = 20000;
const PI_SUPPORTED_CAPABILITIES: GhostRuntimeCapability[] = [
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
  "reload",
  "backgroundTaskKill",
  "nudge",
  "nudgeStatus",
  "schedules"
];

type LogContext = Record<string, unknown>;

type TextBlock = {
  type?: string;
  text?: string;
};

type PiModel = {
  provider: string;
  id: string;
  contextWindow?: number;
};

type PiAgentMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  toolName?: string;
};

type PiAgentEvent = {
  type: string;
  message?: PiAgentMessage;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  messages?: unknown[];
};

type PiPromptImage = {
  type: "image";
  mimeType: string;
  data: string;
};

type SlashCommandHandler = (res: ServerResponse, args: string) => Promise<void> | void;

type SlashCommand = {
  name: string;
  description: string;
  handler: SlashCommandHandler;
};

const isMessageUpdateEvent = (event: PiAgentEvent): boolean => event.type === "message_update";
const isMessageEndEvent = (event: PiAgentEvent): boolean => event.type === "message_end";
const isToolExecutionStartEvent = (event: PiAgentEvent): boolean => event.type === "tool_execution_start";
const isToolExecutionEndEvent = (event: PiAgentEvent): boolean => event.type === "tool_execution_end";
const isAgentEndEvent = (event: PiAgentEvent): boolean => event.type === "agent_end";

const extractAgentEndError = (event: PiAgentEvent): string | undefined => {
  if (!Array.isArray(event.messages)) return undefined;
  for (const msg of event.messages) {
    const message = msg as PiAgentMessage & { errorMessage?: string };
    if (message.role === "assistant" && message.errorMessage) {
      return message.errorMessage;
    }
  }
  return undefined;
};

const formatContext = (context?: LogContext): string => {
  if (!context) return "";

  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ' {"context":"unserializable"}';
  }
};

const serializeError = (error: unknown): LogContext => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? ""
    };
  }

  return { error };
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

const log = {
  info: (message: string, context?: LogContext): void => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [ghost-server] INFO ${message}${formatContext(context)}`);
  },
  error: (message: string, context?: LogContext): void => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ghost-server] ERROR ${message}${formatContext(context)}`);
  }
};

const sendJsonLine = (res: ServerResponse, payload: GhostMessage): void => {
  res.write(`${JSON.stringify(payload)}\n`);
};

const getRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const parseJsonRequestBody = async <T>(req: IncomingMessage): Promise<T> => {
  const body = await getRequestBody(req);
  if (!body.trim()) {
    return {} as T;
  }

  return JSON.parse(body) as T;
};

const parseJsonRequestBodyOrRespond = async <T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> => {
  try {
    return await parseJsonRequestBody<T>(req);
  } catch (error) {
    if (error instanceof SyntaxError) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return undefined;
    }

    throw error;
  }
};

const getScheduleHostUrl = (path: string): string => {
  if (!ghostName) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }

  return `http://host.docker.internal:${hostApiPort}/api/ghosts/${encodeURIComponent(ghostName)}${path}`;
};

const requestHostSchedules = async (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> => {
  const response = await fetch(getScheduleHostUrl(path), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ghostApiKey ? { Authorization: `Bearer ${ghostApiKey}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!response.ok) {
    let message = `Schedule request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.length > 0) {
        message = payload.error;
      }
    } catch {}
    throw new Error(message);
  }

  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text) as unknown;
};

const getMailboxHostUrl = (path: string): string => `http://host.docker.internal:${hostApiPort}${path}`;

const requestHostMailbox = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(getMailboxHostUrl(path), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ghostApiKey ? { Authorization: `Bearer ${ghostApiKey}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!response.ok) {
    let message = `Mailbox request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.length > 0) {
        message = payload.error;
      }
    } catch {}
    throw new Error(message);
  }

  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text) as unknown;
};

const formatScheduleSummary = (schedule: GhostSchedule): string => {
  const nextFire = schedule.nextFire ?? "disabled";
  const fired = schedule.lastFired ?? "never";
  return [
    `id: ${schedule.id}`,
    `cron: ${schedule.cron}`,
    `next: ${nextFire}`,
    `last: ${fired}`,
    `once: ${schedule.once ? "yes" : "no"}`,
    `timezone: ${schedule.timezone}`,
    `enabled: ${schedule.enabled ? "yes" : "no"}`,
    `prompt: ${schedule.prompt}`
  ].join("\n");
};

const formatScheduleList = (schedules: GhostSchedule[]): string => {
  if (schedules.length === 0) {
    return "No schedules found.";
  }

  return schedules.map(formatScheduleSummary).join("\n\n");
};

const formatMailboxSummary = (message: MailMessage): string =>
  [
    `id: ${message.id}`,
    `from: ${message.from}`,
    `to: ${message.to}`,
    `subject: ${message.subject}`,
    `sent: ${message.sentAt}`,
    `read: ${message.readAt ?? "unread"}`,
    `priority: ${message.priority}`
  ].join("\n");

const formatMailboxList = (messages: MailMessage[]): string => {
  if (messages.length === 0) {
    return "No messages found.";
  }

  return messages.map(formatMailboxSummary).join("\n\n");
};

const formatMailboxUnreadSummary = (messages: MailMessage[]): string => {
  const header = `${messages.length} unread message${messages.length === 1 ? "" : "s"}.`;
  if (messages.length === 0) {
    return header;
  }

  const lines = messages.map((message) => `- ${message.from}: ${message.subject}`);
  return [header, ...lines].join("\n");
};

const formatMailboxMessage = (message: MailMessage): string =>
  [
    `id: ${message.id}`,
    `from: ${message.from}`,
    `to: ${message.to}`,
    `subject: ${message.subject}`,
    `sent: ${message.sentAt}`,
    `read: ${message.readAt ?? "unread"}`,
    `priority: ${message.priority}`,
    `thread: ${message.threadId ?? message.id}`,
    "",
    message.body
  ].join("\n");

const defaultHeartbeatPrompt =
  "Heartbeat check. Review your memory, check if there's anything you should follow up on or proactively do for the user.";

const scheduleUsageText = [
  "Usage:",
  "/schedule list",
  "/schedule add <cron> <prompt>",
  "/schedule delete <id>",
  "/schedule heartbeat <interval_seconds>"
].join("\n");

const listHostSchedules = async (): Promise<GhostSchedule[]> =>
  requestHostSchedules("GET", "/schedules") as Promise<GhostSchedule[]>;

const createHostSchedule = async (input: ScheduleCreateInput): Promise<GhostSchedule> =>
  requestHostSchedules("POST", "/schedules", input) as Promise<GhostSchedule>;

const deleteHostSchedule = async (id: string): Promise<unknown> =>
  requestHostSchedules("DELETE", `/schedules/${encodeURIComponent(id)}`);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isMailMessage = (value: unknown): value is MailMessage => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.from === "string" &&
    (value.authenticatedBy === null || typeof value.authenticatedBy === "string") &&
    typeof value.to === "string" &&
    typeof value.subject === "string" &&
    typeof value.body === "string" &&
    typeof value.sentAt === "string" &&
    (value.readAt === null || typeof value.readAt === "string") &&
    (value.threadId === null || typeof value.threadId === "string") &&
    (value.priority === "normal" || value.priority === "urgent")
  );
};

const isMailboxState = (value: unknown): value is MailboxState => {
  return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isMailMessage);
};

const extractMailboxMessages = (payload: unknown): MailMessage[] => {
  if (Array.isArray(payload) && payload.every(isMailMessage)) {
    return payload;
  }

  if (isMailboxState(payload)) {
    return payload.messages;
  }

  throw new Error("Mailbox response was not in the expected format.");
};

const extractMailboxMessage = (payload: unknown): MailMessage => {
  if (isMailMessage(payload)) {
    return payload;
  }

  throw new Error("Mailbox message response was not in the expected format.");
};

const listMailboxMessages = async (options?: { unread?: boolean }): Promise<MailMessage[]> => {
  if (!ghostName) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }

  const suffix = options?.unread ? "?unread=true" : "";
  const data = await requestHostMailbox("GET", `/api/mail/${encodeURIComponent(ghostName)}${suffix}`);
  return extractMailboxMessages(data);
};

const getMailboxMessage = async (messageId: string): Promise<MailMessage> => {
  const messages = await listMailboxMessages();
  const message = messages.find((entry) => entry.id === messageId);

  if (!message) {
    throw new Error(`Mailbox message "${messageId}" not found.`);
  }

  return extractMailboxMessage(message);
};

const markMailboxMessageRead = async (messageId: string): Promise<unknown> =>
  requestHostMailbox("POST", `/api/mail/${encodeURIComponent(messageId)}/read`);

const sendMailboxMessage = async (input: {
  to: string;
  subject: string;
  body: string;
  priority: "normal" | "urgent";
  threadId?: string;
}): Promise<unknown> => {
  if (!ghostName) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }

  return requestHostMailbox("POST", "/api/mail/send", {
    from: ghostName,
    to: input.to,
    subject: input.subject,
    body: input.body,
    priority: input.priority,
    ...(input.threadId ? { threadId: input.threadId } : {})
  });
};

const requireScheduleCreateInput = (
  input: ScheduleCreateInput
): {
  cron: string;
  prompt: string;
  once?: boolean;
  timezone?: string;
} => {
  if (typeof input.cron !== "string" || input.cron.trim().length === 0) {
    throw new Error("cron is required when action is create.");
  }

  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error("prompt is required when action is create.");
  }

  return {
    cron: input.cron,
    prompt: input.prompt,
    once: input.once,
    timezone: input.timezone
  };
};

const requireScheduleId = (id: string | undefined): string => {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("id is required when action is delete.");
  }

  return id;
};

const requireMailboxSendInput = (
  input: MailSendInput
): {
  to: string;
  subject: string;
  body: string;
  priority: "normal" | "urgent";
} => {
  if (typeof input.to !== "string" || input.to.trim().length === 0) {
    throw new Error("to is required when action is send.");
  }

  if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
    throw new Error("subject is required when action is send.");
  }

  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new Error("body is required when action is send.");
  }

  return {
    to: input.to,
    subject: input.subject,
    body: input.body,
    priority: input.priority ?? "normal"
  };
};

const requireMailboxMessageId = (messageId: string | undefined, action: "read" | "reply"): string => {
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw new Error(`messageId is required when action is ${action}.`);
  }

  return messageId;
};

const requireMailboxReplyBody = (body: string | undefined): string => {
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new Error("body is required when action is reply.");
  }

  return body;
};

const listScheduleOperation = async (): Promise<{ data: GhostSchedule[]; text: string }> => {
  const data = await listHostSchedules();
  return { data, text: formatScheduleList(data) };
};

const createScheduleOperation = async (
  input: ScheduleCreateInput,
  options?: { successText?: string; validate?: boolean }
): Promise<{ data: GhostSchedule; text: string }> => {
  const data = await createHostSchedule(options?.validate === false ? input : requireScheduleCreateInput(input));
  return {
    data,
    text: `${options?.successText ?? "Schedule created."}\n\n${formatScheduleSummary(data)}`
  };
};

const deleteScheduleOperation = async (
  id: string | undefined
): Promise<{
  data: unknown;
  id: string;
  text: string;
}> => {
  const scheduleId = requireScheduleId(id);
  const data = await deleteHostSchedule(scheduleId);
  return {
    data,
    id: scheduleId,
    text: `Deleted schedule ${scheduleId}.`
  };
};

const checkMailboxOperation = async (): Promise<{ data: MailMessage[]; text: string }> => {
  const data = await listMailboxMessages({ unread: true });
  return { data, text: formatMailboxUnreadSummary(data) };
};

const inboxMailboxOperation = async (): Promise<{ data: MailMessage[]; text: string }> => {
  const data = await listMailboxMessages();
  return { data, text: formatMailboxList(data) };
};

const readMailboxOperation = async (
  messageId: string | undefined
): Promise<{
  data: MailMessage;
  text: string;
}> => {
  const id = requireMailboxMessageId(messageId, "read");
  await markMailboxMessageRead(id);
  const data = await getMailboxMessage(id);
  return { data, text: formatMailboxMessage(data) };
};

const sendMailboxOperation = async (
  input: MailSendInput
): Promise<{
  data: unknown;
  text: string;
}> => {
  const validated = requireMailboxSendInput(input);
  const data = await sendMailboxMessage(validated);
  return {
    data,
    text: `Sent message to ${validated.to}: ${validated.subject}`
  };
};

const replyMailboxOperation = async (
  messageId: string | undefined,
  body: string | undefined,
  priority?: "normal" | "urgent"
): Promise<{
  data: unknown;
  text: string;
}> => {
  const id = requireMailboxMessageId(messageId, "reply");
  const replyBody = requireMailboxReplyBody(body);
  const original = await getMailboxMessage(id);
  const data = await sendMailboxMessage({
    to: original.from,
    subject: original.subject,
    body: replyBody,
    priority: priority ?? "normal",
    threadId: original.threadId ?? original.id
  });

  return {
    data,
    text: `Replied to ${original.from}: ${original.subject}`
  };
};

const toHeartbeatCron = (intervalSeconds: number): string => {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Heartbeat interval must be a positive integer.");
  }

  if (intervalSeconds % 60 !== 0) {
    throw new Error("Heartbeat interval must be a whole number of minutes.");
  }

  const intervalMinutes = intervalSeconds / 60;

  if (intervalMinutes === 1) {
    return "* * * * *";
  }

  if (intervalMinutes < 60 && 60 % intervalMinutes === 0) {
    return `*/${intervalMinutes} * * * *`;
  }

  if (intervalMinutes === 60) {
    return "0 * * * *";
  }

  if (intervalMinutes % 60 === 0) {
    const intervalHours = intervalMinutes / 60;

    if (intervalHours < 24 && 24 % intervalHours === 0) {
      return `0 */${intervalHours} * * *`;
    }
  }

  if (intervalMinutes === 24 * 60) {
    return "0 0 * * *";
  }

  if (intervalMinutes === 7 * 24 * 60) {
    return "0 0 * * 0";
  }

  throw new Error("Heartbeat interval must cleanly map to a standard 5-field cron schedule.");
};

const toToolTextResult = (text: string, details?: unknown) => ({
  content: [{ type: "text", text }],
  ...(details === undefined ? {} : { details })
});

const getAssistantText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const candidate = block as TextBlock;
      if (candidate.type !== "text" || typeof candidate.text !== "string") return "";
      return candidate.text;
    })
    .join("");
};

const summarizeValue = (value: unknown): string => {
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

const getContentText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  return getAssistantText(content);
};

const getContentSummary = (content: unknown): string => {
  const text = getContentText(content);
  if (text) {
    return text;
  }

  return summarizeValue(content);
};

const getMessageTimestamp = (message: PiAgentMessage): string | undefined => {
  const { timestamp } = message;

  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(timestamp);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return timestamp;
};

const countImageBlocks = (content: unknown): number => {
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => typeof block === "object" && block !== null && (block as TextBlock).type === "image")
    .length;
};

const extractImageBlocks = (content: unknown): GhostImage[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => typeof block === "object" && block !== null && (block as TextBlock).type === "image")
    .map((block) => {
      const candidate = block as { mimeType?: string; data?: string; source?: { mediaType?: string; data?: string } };
      return {
        mediaType: candidate.mimeType || candidate.source?.mediaType || "image/png",
        data: candidate.data || candidate.source?.data || ""
      };
    })
    .filter((image) => image.data.length > 0);
};

const createHistoryMessage = (
  role: HistoryMessage["role"],
  text: string,
  options?: {
    allowEmptyText?: boolean;
    toolName?: string;
    timestamp?: string;
    attachmentCount?: number;
    images?: GhostImage[];
  }
): HistoryMessage | null => {
  const trimmedText = text.trim();
  if (!trimmedText && options?.allowEmptyText !== true) {
    return null;
  }

  return {
    role,
    text: trimmedText,
    ...(options?.toolName ? { toolName: options.toolName } : {}),
    ...(options?.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options?.attachmentCount ? { attachmentCount: options.attachmentCount } : {}),
    ...(options?.images ? { images: options.images } : {})
  };
};

const getHistoryMessages = (messages: PiAgentMessage[]): HistoryMessage[] => {
  return messages.flatMap((message) => {
    const timestamp = getMessageTimestamp(message);
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;

    if (message.role === "user" || message.role === "system") {
      const imageCount = message.role === "user" ? countImageBlocks(message.content) : 0;
      const images = imageCount > 0 ? extractImageBlocks(message.content) : undefined;
      const historyMessage = createHistoryMessage(message.role, getContentText(message.content), {
        timestamp,
        allowEmptyText: imageCount > 0,
        ...(imageCount > 0 ? { attachmentCount: imageCount } : {}),
        ...(images && images.length > 0 ? { images } : {})
      });
      return historyMessage ? [historyMessage] : [];
    }

    if (message.role === "assistant") {
      const historyMessages: HistoryMessage[] = [];
      const assistantMessage = createHistoryMessage("assistant", getContentText(message.content), { timestamp });

      if (assistantMessage) {
        historyMessages.push(assistantMessage);
      }

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "toolCall") {
            continue;
          }

          const toolUseMessage = createHistoryMessage("tool_use", summarizeValue(block.arguments), {
            allowEmptyText: true,
            toolName: typeof block.name === "string" ? block.name : undefined,
            timestamp
          });

          if (toolUseMessage) {
            historyMessages.push(toolUseMessage);
          }
        }
      }

      return historyMessages;
    }

    if (message.role === "toolResult" || message.role === "tool_result") {
      const historyMessage = createHistoryMessage("tool_result", getContentSummary(message.content), {
        allowEmptyText: true,
        toolName,
        timestamp
      });
      return historyMessage ? [historyMessage] : [];
    }

    if (message.role === "toolUse" || message.role === "tool_use") {
      const historyMessage = createHistoryMessage("tool_use", getContentSummary(message.content), {
        allowEmptyText: true,
        toolName,
        timestamp
      });
      return historyMessage ? [historyMessage] : [];
    }

    return [];
  });
};

const parseModelRef = (value: string): { provider: string; modelId: string } => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(`Invalid model format: ${value}`);
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1)
  };
};

const resolveModel = (modelRegistry: ModelRegistry, value: string): PiModel => {
  const { provider, modelId } = parseModelRef(value);
  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }

  return model;
};

const getCompactionSettings = (
  model: PiModel | undefined
): {
  modelContextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
} => {
  const modelContextWindow = model?.contextWindow ?? defaultModelContextWindow;

  return {
    modelContextWindow,
    reserveTokens: defaultReserveTokens,
    keepRecentTokens
  };
};

const writeCompactionSettings = (
  path: string,
  model: PiModel | undefined
): ReturnType<typeof getCompactionSettings> => {
  let existingSettings: Record<string, unknown> = {};

  try {
    existingSettings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    existingSettings = {};
  }

  const compactionSettings = getCompactionSettings(model);
  const existingCompaction = isRecord(existingSettings.compaction) ? existingSettings.compaction : {};

  const nextSettings = {
    ...existingSettings,
    compaction: {
      ...existingCompaction,
      enabled: true,
      reserveTokens: compactionSettings.reserveTokens,
      keepRecentTokens: compactionSettings.keepRecentTokens
    }
  };

  writeFileSync(path, JSON.stringify(nextSettings, null, 2));

  return compactionSettings;
};

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const startupModelValue = process.env.GHOSTBOX_MODEL;
const configuredApiKeys = parseApiKeys(process.env.GHOSTBOX_API_KEYS);
const startupModel = startupModelValue ? resolveModel(modelRegistry, startupModelValue) : undefined;
const compactionSettings = writeCompactionSettings(settingsPath, startupModel);

const scheduleTool: ToolDefinition<ScheduleToolParams> = {
  name: "schedule",
  label: "Schedule",
  description: "Create, list, or delete recurring prompts that will be sent to this ghost by the host scheduler.",
  parameters: scheduleToolSchema,
  async execute(_toolCallId, params) {
    if (params.action === "list") {
      const result = await listScheduleOperation();
      return toToolTextResult(result.text, result.data);
    }

    if (params.action === "create") {
      const result = await createScheduleOperation(params);
      return toToolTextResult(result.text, result.data);
    }

    const result = await deleteScheduleOperation(params.id);
    return toToolTextResult(result.text, { id: result.id });
  }
};

const mailboxTool: ToolDefinition<MailboxToolParams> = {
  name: "mailbox",
  label: "Mailbox",
  description:
    "Send and receive messages to/from other ghosts and the user. Use this to communicate with other agents or check for messages.",
  parameters: mailboxToolSchema,
  async execute(_toolCallId, params) {
    if (params.action === "check") {
      const result = await checkMailboxOperation();
      return toToolTextResult(result.text, result.data);
    }

    if (params.action === "inbox") {
      const result = await inboxMailboxOperation();
      return toToolTextResult(result.text, result.data);
    }

    if (params.action === "read") {
      const result = await readMailboxOperation(params.messageId);
      return toToolTextResult(result.text, result.data);
    }

    if (params.action === "send") {
      const result = await sendMailboxOperation(params);
      return toToolTextResult(result.text, result.data);
    }

    const result = await replyMailboxOperation(params.messageId, params.body, params.priority);
    return toToolTextResult(result.text, result.data);
  }
};

const sessionManagerCandidate = SessionManager.continueRecent("/vault");
let sessionManager = sessionManagerCandidate.getSessionFile()
  ? sessionManagerCandidate
  : SessionManager.create("/vault");
const resumedSession = Boolean(sessionManagerCandidate.getSessionFile());

const resourceLoader = new DefaultResourceLoader({
  cwd: "/vault",
  systemPromptOverride: () => buildSystemPrompt(),
  appendSystemPromptOverride: () => []
});
await resourceLoader.reload();

let currentModelValue = startupModelValue ?? "default";

const getConfiguredModel = () => {
  if (!currentModelValue || currentModelValue === "default") {
    return startupModel;
  }

  return resolveModel(modelRegistry, currentModelValue);
};

const createManagedSession = async (nextSessionManager: SessionManager): Promise<AgentSession> => {
  const { session: nextSession } = await createAgentSession({
    cwd: "/vault",
    sessionManager: nextSessionManager,
    model: getConfiguredModel(),
    authStorage,
    modelRegistry,
    tools: codingTools,
    customTools: [scheduleTool, mailboxTool],
    resourceLoader
  });

  return nextSession;
};

let session = await createManagedSession(sessionManager);

log.info("Pi session ready", {
  sessionId: session.sessionId,
  resumed: resumedSession,
  model: startupModelValue ?? "default",
  apiKeyCount: configuredApiKeys.length,
  compaction: {
    settingsPath,
    modelContextWindow: compactionSettings.modelContextWindow,
    reserveTokens: compactionSettings.reserveTokens,
    keepRecentTokens: compactionSettings.keepRecentTokens
  }
});

let requestQueue: Promise<void> = Promise.resolve();

const runQueued = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = requestQueue.catch(() => undefined).then(task);
  requestQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

const toPiPromptImages = (images: GhostImage[] | undefined): PiPromptImage[] | undefined => {
  if (!images) {
    return undefined;
  }

  return images.map(({ mediaType, data }) => ({
    type: "image",
    mimeType: mediaType,
    data
  }));
};

const isStreamingBehavior = (value: unknown): value is GhostStreamingBehavior => {
  return value === "steer" || value === "followUp";
};

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const parseRequestImages = (imagesValue: unknown): { images?: GhostImage[]; error?: string } => {
  if (imagesValue === undefined) {
    return {};
  }

  if (!Array.isArray(imagesValue)) {
    return { error: "Invalid images" };
  }

  const images: GhostImage[] = [];

  for (const image of imagesValue) {
    if (!image || typeof image !== "object") {
      return { error: "Invalid images" };
    }

    const { mediaType, data } = image as { mediaType?: unknown; data?: unknown };

    if (typeof mediaType !== "string" || typeof data !== "string") {
      return { error: "Invalid images" };
    }

    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      return { error: `Unsupported image type: ${mediaType}. Must be jpeg, png, gif, or webp.` };
    }
    images.push({ mediaType, data });
  }

  return { images };
};

const startNdjsonResponse = (res: ServerResponse): void => {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
};

const sendAssistantResult = (res: ServerResponse, text: string, options?: { end?: boolean }): void => {
  sendJsonLine(res, {
    type: "assistant",
    text
  });

  sendJsonLine(res, {
    type: "result",
    text: "",
    sessionId: session.sessionId
  });

  if (options?.end !== false) {
    res.end();
  }
};

const streamPrompt = async (
  res: ServerResponse,
  prompt: string,
  modelValue?: string,
  images?: GhostImage[],
  streamingBehavior?: GhostStreamingBehavior
): Promise<void> => {
  startNdjsonResponse(res);

  if (modelValue) {
    const nextModel = resolveModel(session.modelRegistry, modelValue);
    await session.setModel(nextModel);
    currentModelValue = `${nextModel.provider}/${nextModel.id}`;
    log.info("Pi model switched", { model: `${nextModel.provider}/${nextModel.id}` });
  }

  let currentAssistantText = "";
  let lastAssistantText = "";
  let currentThinkingText = "";
  let unsubscribe = (): void => {};
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      sendJsonLine(res, { type: "heartbeat" } as GhostMessage);
    }, 30_000);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    unsubscribe = session.subscribe((rawEvent) => {
      const event = rawEvent as PiAgentEvent;

      try {
        const assistantMessageEvent = event.assistantMessageEvent;
        const assistantMessageEventType = assistantMessageEvent?.type;

        if (isMessageUpdateEvent(event)) {
          if (assistantMessageEventType === "thinking_start") {
            currentThinkingText = typeof assistantMessageEvent?.delta === "string" ? assistantMessageEvent.delta : "";
            sendJsonLine(res, {
              type: "thinking",
              text: currentThinkingText
            });
            return;
          }

          if (assistantMessageEventType === "thinking_delta" && typeof assistantMessageEvent?.delta === "string") {
            currentThinkingText += assistantMessageEvent.delta;
            sendJsonLine(res, {
              type: "thinking",
              text: currentThinkingText
            });
            return;
          }

          if (assistantMessageEventType === "thinking_end") {
            if (typeof assistantMessageEvent?.delta === "string") {
              currentThinkingText += assistantMessageEvent.delta;
            }

            sendJsonLine(res, {
              type: "thinking",
              text: currentThinkingText
            });
            currentThinkingText = "";
            return;
          }

          if (assistantMessageEventType === "text_delta" && typeof assistantMessageEvent?.delta === "string") {
            currentAssistantText += assistantMessageEvent.delta;
            return;
          }
        }

        if (isMessageEndEvent(event) && event.message?.role === "assistant") {
          const message = event.message as PiAgentMessage & { stopReason?: string; errorMessage?: string };
          const fullText = currentAssistantText || getAssistantText(event.message.content);

          if (message.stopReason === "error" || message.stopReason === "aborted") {
            const errorText = message.errorMessage || "Agent encountered an error.";
            log.error("SDK assistant error", { stopReason: message.stopReason, error: errorText });
            sendJsonLine(res, { type: "assistant", text: errorText });
            currentAssistantText = "";
            return;
          }

          if (fullText) {
            lastAssistantText = fullText;
            log.info("SDK assistant", {
              chars: fullText.length,
              preview: fullText.slice(0, 200)
            });
            sendJsonLine(res, {
              type: "assistant",
              text: fullText
            });
          }
          currentAssistantText = "";
          return;
        }

        if (isToolExecutionStartEvent(event) && typeof event.toolName === "string") {
          log.info("SDK tool_use", { tool: event.toolName });
          sendJsonLine(res, {
            type: "tool_use",
            tool: event.toolName,
            input: event.args ?? null
          });
          startHeartbeat();
          return;
        }

        if (isToolExecutionEndEvent(event)) {
          stopHeartbeat();
          const preview = typeof event.result === "string" ? event.result.slice(0, 200) : "";
          log.info("SDK tool_result", { preview, isError: event.isError });
          sendJsonLine(res, {
            type: "tool_result",
            output: event.result ?? null
          });
          return;
        }

        if (isAgentEndEvent(event)) {
          stopHeartbeat();
          const errorText = extractAgentEndError(event);
          if (errorText) {
            log.error("SDK agent_end error", { error: errorText, sessionId: session.sessionId });
          }
          log.info("SDK result", { sessionId: session.sessionId, hasError: Boolean(errorText) });
          sendJsonLine(res, {
            type: "result",
            text: lastAssistantText || errorText || "",
            sessionId: session.sessionId
          });
          resolve();
        }
      } catch (error) {
        stopHeartbeat();
        unsubscribe();
        reject(error);
      }
    });
  });

  try {
    const transformedImages = toPiPromptImages(images);
    const promptOptions: {
      images?: PiPromptImage[];
      streamingBehavior?: GhostStreamingBehavior;
    } = {};

    if (transformedImages && transformedImages.length > 0) {
      promptOptions.images = transformedImages;
    }

    if (streamingBehavior) {
      promptOptions.streamingBehavior = streamingBehavior;
    }

    log.info("Pi prompt start", {
      sessionId: session.sessionId,
      chars: prompt.length,
      imageCount: transformedImages?.length ?? 0,
      preview: prompt.slice(0, 200)
    });

    if (promptOptions.images || promptOptions.streamingBehavior) {
      await session.prompt(prompt, promptOptions);
    } else {
      await session.prompt(prompt);
    }

    await completion;

    nudges.emit("message-complete", "post-prompt").catch((error) => {
      log.error("Nudge emit failed", serializeError(error));
    });
  } catch (error) {
    unsubscribe();
    log.error("Message processing failed", serializeError(error));
    sendJsonLine(res, {
      type: "result",
      text: "Ghost server failed while processing message.",
      sessionId: session.sessionId
    });
  } finally {
    unsubscribe();
    res.end();
  }
};

const slashCommands = new Map<string, SlashCommand>();

const registerSlashCommand = (command: SlashCommand): void => {
  const key = command.name.startsWith("/") ? command.name.slice(1) : command.name;
  slashCommands.set(key, command);
};

const getRuntimeMeta = (): GhostRuntimeMeta => ({
  adapter: "pi",
  runtimeVersion,
  imageVersion,
  supportedCapabilities: [...PI_SUPPORTED_CAPABILITIES],
  supportedCommands: Array.from(slashCommands.values()).map(({ name, description }) => ({
    name,
    description
  })),
  currentModel: currentModelValue === "default" ? (startupModelValue ?? null) : currentModelValue,
  currentSessionId: session.sessionId
});

const nudges = new NudgeRegistry(log, serializeError);
const { flushMemories, runMemoryObserver } = createGhostMemory({
  log,
  serializeError,
  getContentText,
  getSession: () => session
});

registerDefaultNudgeHandlers(nudges, {
  log,
  serializeError,
  flushMemories,
  runMemoryObserver
});

registerSlashCommand({
  name: "/compact",
  description: "Compact the current session and reduce context.",
  handler: async (res) => {
    try {
      log.info("Pi slash compact start", { sessionId: session.sessionId });
      await nudges.emit("pre-compact", "slash-command");
      await session.compact();
      await session.reload();
      log.info("Pi slash compact complete", { sessionId: session.sessionId });
      sendAssistantResult(res, "Session compacted. Context reduced.");
    } catch (error) {
      log.error("Pi slash compact failed", serializeError(error));
      sendAssistantResult(res, error instanceof Error ? error.message : "Compaction failed.");
    }
  }
});

registerSlashCommand({
  name: "/reload",
  description: "Reload extensions from /vault/.pi/extensions/.",
  handler: async (res) => {
    try {
      log.info("Pi slash reload start", { sessionId: session.sessionId });
      await session.reload();
      log.info("Pi slash reload complete", { sessionId: session.sessionId });
      sendAssistantResult(res, "Extensions reloaded. New tools are now available.");
    } catch (error) {
      log.error("Pi slash reload failed", serializeError(error));
      sendAssistantResult(res, error instanceof Error ? error.message : "Reload failed.");
    }
  }
});

registerSlashCommand({
  name: "/history",
  description: "Show session history counts and session details.",
  handler: (res) => {
    const historyMessages = getHistoryMessages(session.messages);
    const lines = [
      `Session ID: ${session.sessionId}`,
      `Current model: ${currentModelValue}`,
      `Message count: ${session.messages.length}`,
      `History entries: ${historyMessages.length}`,
      `Session file: ${session.sessionFile ?? "none"}`
    ];
    sendAssistantResult(res, lines.join("\n"));
  }
});

registerSlashCommand({
  name: "/model",
  description: "Show the current model or switch to /model <provider/id>.",
  handler: async (res, args) => {
    const nextModelValue = args.trim();

    if (!nextModelValue) {
      sendAssistantResult(res, `Current model: ${currentModelValue}`);
      return;
    }

    try {
      const nextModel = resolveModel(session.modelRegistry, nextModelValue);
      await session.setModel(nextModel);
      currentModelValue = `${nextModel.provider}/${nextModel.id}`;
      log.info("Pi slash model switched", { model: currentModelValue });
      sendAssistantResult(res, `Model switched to ${currentModelValue}.`);
    } catch (error) {
      log.error("Pi slash model switch failed", serializeError(error));
      sendAssistantResult(res, error instanceof Error ? error.message : "Model switch failed.");
    }
  }
});

registerSlashCommand({
  name: "/schedule",
  description: "Manage scheduled prompts with list, add, delete, or heartbeat.",
  handler: async (res, args) => {
    const trimmed = args.trim();
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    const action = parts[0]?.toLowerCase() ?? "";

    try {
      if (action === "list") {
        const result = await listScheduleOperation();
        sendAssistantResult(res, result.text);
        return;
      }

      if (action === "add") {
        if (parts.length < 7) {
          sendAssistantResult(res, scheduleUsageText);
          return;
        }

        const cron = parts.slice(1, 6).join(" ");
        const prompt = parts.slice(6).join(" ").trim();

        if (!prompt) {
          sendAssistantResult(res, scheduleUsageText);
          return;
        }

        const result = await createScheduleOperation({ cron, prompt });
        sendAssistantResult(res, result.text);
        return;
      }

      if (action === "delete") {
        const id = parts[1]?.trim();

        if (!id) {
          sendAssistantResult(res, scheduleUsageText);
          return;
        }

        const result = await deleteScheduleOperation(id);
        sendAssistantResult(res, result.text);
        return;
      }

      if (action === "heartbeat") {
        const intervalSeconds = Number(parts[1]);

        if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
          sendAssistantResult(res, scheduleUsageText);
          return;
        }

        const cron = toHeartbeatCron(intervalSeconds);
        const result = await createScheduleOperation(
          {
            cron,
            prompt: defaultHeartbeatPrompt
          },
          { successText: "Heartbeat schedule created." }
        );
        sendAssistantResult(res, result.text);
        return;
      }

      sendAssistantResult(res, scheduleUsageText);
    } catch (error) {
      log.error("Pi slash schedule failed", serializeError(error));
      sendAssistantResult(res, error instanceof Error ? error.message : "Schedule command failed.");
    }
  }
});

registerSlashCommand({
  name: "/help",
  description: "List available slash commands.",
  handler: (res) => {
    const commandList = Array.from(slashCommands.values())
      .map((command) => `${command.name} - ${command.description}`)
      .join("\n");
    sendAssistantResult(res, commandList);
  }
});

registerSlashCommand({
  name: "/new",
  description: "Start a fresh session. Clears all messages and history.",
  handler: async (res) => {
    try {
      log.info("Pi slash new start", { sessionId: session.sessionId });
      await nudges.emit("pre-new-session", "slash-command");
      await session.reload();
      await session.newSession();
      nudges.resetCounters();
      nudges.emit("session-start", "slash-new").catch((error) => {
        log.error("Session-start nudge failed", serializeError(error));
      });
      log.info("Pi slash new complete", { sessionId: session.sessionId });
      sendAssistantResult(res, "New session started.");
    } catch (error) {
      log.error("Pi slash new failed", serializeError(error));
      sendAssistantResult(res, error instanceof Error ? error.message : "New session failed.");
    }
  }
});

const handlers = createGhostHandlers({
  log,
  serializeError,
  getRequestBody,
  parseJsonRequestBody,
  parseJsonRequestBodyOrRespond,
  parseRequestImages,
  isStreamingBehavior,
  toPiPromptImages,
  startNdjsonResponse,
  sendAssistantResult,
  streamPrompt,
  runQueued,
  slashCommands,
  getHistoryMessages,
  getSession: () => session,
  setSession: (nextSession) => {
    session = nextSession;
  },
  getSessionManager: () => sessionManager,
  setSessionManager: (nextSessionManager) => {
    sessionManager = nextSessionManager;
  },
  createManagedSession,
  getCurrentModelValue: () => currentModelValue,
  getRuntimeMeta,
  nudges,
  nudgeEvents: NUDGE_EVENTS,
  listScheduleOperation,
  createScheduleOperation,
  deleteScheduleOperation
});

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  log.info("Request received", { method: req.method, url: req.url ?? "" });

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    log.info("Response sent", { method: req.method, url: req.url, status: 200 });
    return;
  }

  if (configuredApiKeys.length > 0) {
    const authorization = req.headers.authorization;
    const bearerToken =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";

    if (!bearerToken || !configuredApiKeys.includes(bearerToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      log.info("Response sent", { method: req.method, url: req.url, status: 401 });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/message") {
    await handlers.handleMessage(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/steer") {
    await handlers.handleSteer(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/queue") {
    await handlers.handleQueue(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/clear-queue") {
    await handlers.handleClearQueue(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/timeline")) {
    await handlers.handleTimeline(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/sessions") {
    await handlers.handleSessions(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    await handlers.handleStats(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (
    (req.method === "GET" && req.url === "/schedules") ||
    (req.method === "POST" && req.url === "/schedules") ||
    (req.method === "DELETE" && req.url?.startsWith("/schedules/"))
  ) {
    await handlers.handleSchedules(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/commands") {
    await handlers.handleCommands(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/runtime/meta") {
    await handlers.handleRuntimeMeta(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "GET" && req.url === "/nudge/status") {
    await handlers.handleNudgeStatus(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/nudge") {
    await handlers.handleNudge(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/reload") {
    await handlers.handleReload(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/compact") {
    await handlers.handleCompact(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/abort") {
    await handlers.handleAbort(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/tasks/")) {
    await handlers.handleTaskKill(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/new") {
    await handlers.handleNewSession(res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/sessions/switch") {
    await handlers.handleSwitchSession(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "POST" && req.url === "/sessions/rename") {
    await handlers.handleRenameSession(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/sessions/")) {
    await handlers.handleDeleteSession(req, res);
    log.info("Response sent", { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
  log.info("Response sent", { method: req.method, url: req.url, status: 404 });
};

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log.error("Request handling failed", serializeError(error));
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
    log.info("Response sent", { method: req.method, url: req.url ?? "", status: 500 });
  });
});

server.listen(3000, () => {
  log.info("Ghost server listening on port 3000");
});
