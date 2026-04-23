import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { NudgeEvent } from "./ghost-memory";
import type {
  GhostImage,
  GhostQueueState,
  GhostRuntimeMeta,
  GhostSchedule,
  GhostStreamingBehavior,
  HistoryMessage,
  SessionInfo,
  SessionListResponse,
  TimelineItem
} from "./types";

type LogContext = Record<string, unknown>;

type Logger = {
  info: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
};

type SlashCommandHandler = (res: ServerResponse, args: string) => Promise<void> | void;

type SlashCommand = {
  name: string;
  description: string;
  handler: SlashCommandHandler;
};

type PiAgentMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  toolName?: string;
};

type SessionHistoryEntry = {
  type: string;
  message?: PiAgentMessage;
  timestamp?: string;
  summary?: string;
  tokensBefore?: number;
};

type PiPromptImage = {
  type: "image";
  mimeType: string;
  data: string;
};

type RunQueued = <T>(task: () => Promise<T>) => Promise<T>;

type StreamPrompt = (
  res: ServerResponse,
  prompt: string,
  modelValue?: string,
  images?: GhostImage[],
  streamingBehavior?: GhostStreamingBehavior
) => Promise<void>;

type SessionManagerEntry = {
  name?: string | null;
  path: string;
  created?: string | Date;
  modified?: string | Date;
};

type TimelinePageResult = {
  items: TimelineItem[];
  totalCount: number;
  nextBefore: number | null;
};

type NudgeController = {
  emit: (event: NudgeEvent, reason: string) => Promise<void>;
  resetCounters: () => void;
  status: () => unknown;
};

type GhostHandlersDependencies = {
  log: Logger;
  serializeError: (error: unknown) => LogContext;
  getRequestBody: (req: IncomingMessage) => Promise<string>;
  parseJsonRequestBody: <T>(req: IncomingMessage) => Promise<T>;
  parseJsonRequestBodyOrRespond: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | undefined>;
  parseRequestImages: (imagesValue: unknown) => { images?: GhostImage[]; error?: string };
  isStreamingBehavior: (value: unknown) => value is GhostStreamingBehavior;
  toPiPromptImages: (images: GhostImage[] | undefined) => PiPromptImage[] | undefined;
  startNdjsonResponse: (res: ServerResponse) => void;
  sendAssistantResult: (res: ServerResponse, text: string, options?: { end?: boolean }) => void;
  streamPrompt: StreamPrompt;
  runQueued: RunQueued;
  slashCommands: Map<string, SlashCommand>;
  getHistoryMessages: (messages: PiAgentMessage[]) => HistoryMessage[];
  getSession: () => AgentSession;
  setSession: (session: AgentSession) => void;
  getSessionManager: () => SessionManager;
  setSessionManager: (sessionManager: SessionManager) => void;
  createManagedSession: (nextSessionManager: SessionManager) => Promise<AgentSession>;
  getCurrentModelValue: () => string;
  getRuntimeMeta: () => GhostRuntimeMeta;
  nudges: NudgeController;
  nudgeEvents: readonly NudgeEvent[];
  listScheduleOperation: () => Promise<{ data: GhostSchedule[]; text: string }>;
  createScheduleOperation: (
    input: { cron?: string; prompt?: string; once?: boolean; timezone?: string },
    options?: { successText?: string; validate?: boolean }
  ) => Promise<{ data: GhostSchedule; text: string }>;
  deleteScheduleOperation: (id: string | undefined) => Promise<{ data: unknown; id: string; text: string }>;
};

type JsonHandlerResult = {
  status?: number;
  body: unknown;
};

const JSON_HEADERS = { "Content-Type": "application/json" };
const SESSION_NAMES_PATH = "/root/.pi/agent/session-names.json";

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
};

const sendJsonError = (res: ServerResponse, status: number, message: string): void => {
  sendJson(res, status, { error: message });
};

const isNudgeEvent = (value: string, nudgeEvents: readonly NudgeEvent[]): value is NudgeEvent =>
  nudgeEvents.some((event) => event === value);

const getSessionEntries = (sessionManager: SessionManager): SessionHistoryEntry[] =>
  (
    sessionManager as SessionManager & {
      getEntries: () => SessionHistoryEntry[];
    }
  ).getEntries();

const historyMessagesForMessage = (
  message: PiAgentMessage,
  getHistoryMessages: (messages: PiAgentMessage[]) => HistoryMessage[]
): HistoryMessage[] => getHistoryMessages([message]);

const buildTimelineItems = (
  entries: SessionHistoryEntry[],
  getHistoryMessages: (messages: PiAgentMessage[]) => HistoryMessage[]
): TimelineItem[] => {
  const items: TimelineItem[] = [];

  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.type === "compaction") {
      items.push({
        id: `compaction:${entryIndex}`,
        type: "compaction",
        compaction: {
          timestamp: entry.timestamp ?? "",
          summary: entry.summary ?? "",
          tokensBefore: entry.tokensBefore ?? 0
        }
      });
      continue;
    }

    if (entry.type !== "message" || !entry.message) {
      continue;
    }

    const historyMessages = historyMessagesForMessage(entry.message, getHistoryMessages);
    for (const [messageIndex, message] of historyMessages.entries()) {
      items.push({
        id: `message:${entryIndex}:${messageIndex}`,
        type: "message",
        message
      });
    }
  }

  return items;
};

const paginateTimelineItems = (
  items: TimelineItem[],
  before: number | undefined,
  limit: number | undefined
): TimelinePageResult => {
  const totalCount = items.length;
  const boundedBefore = before === undefined ? totalCount : Math.max(0, Math.min(before, totalCount));
  const boundedLimit = limit === undefined ? totalCount : Math.max(1, Math.min(limit, 200));
  const startIndex = Math.max(0, boundedBefore - boundedLimit);

  return {
    items: items.slice(startIndex, boundedBefore),
    totalCount,
    nextBefore: startIndex > 0 ? startIndex : null
  };
};

const parseTimelineRequest = (req: IncomingMessage): { before: number | undefined; limit: number | undefined } => {
  const url = new URL(req.url ?? "/timeline", "http://localhost");
  const limitValue = url.searchParams.get("limit");
  const beforeValue = url.searchParams.get("before");
  const limit = limitValue === null ? undefined : Number(limitValue);
  const before = beforeValue === null ? undefined : Number(beforeValue);

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("Invalid timeline limit");
  }

  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    throw new Error("Invalid timeline cursor");
  }

  return { before, limit };
};

const withJsonResponse = async (
  res: ServerResponse,
  log: Logger,
  serializeError: (error: unknown) => LogContext,
  label: string,
  task: () => Promise<JsonHandlerResult> | JsonHandlerResult,
  fallbackMessage: string
): Promise<void> => {
  try {
    const result = await task();
    sendJson(res, result.status ?? 200, result.body);
  } catch (error) {
    log.error(label, serializeError(error));
    sendJsonError(res, 500, error instanceof Error ? error.message : fallbackMessage);
  }
};

const parseSlashCommandPrompt = (prompt: string): { command: string; args: string } | null => {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const firstSpaceIndex = trimmed.indexOf(" ");
  const rawCommand = firstSpaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpaceIndex);
  const command = rawCommand.trim().toLowerCase();

  if (!command) {
    return null;
  }

  return {
    command,
    args: firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim()
  };
};

const streamSlashCommand = async (
  res: ServerResponse,
  command: SlashCommand,
  args: string,
  startNdjsonResponse: (res: ServerResponse) => void,
  sendAssistantResult: (res: ServerResponse, text: string, options?: { end?: boolean }) => void,
  log: Logger,
  serializeError: (error: unknown) => LogContext
): Promise<void> => {
  startNdjsonResponse(res);

  try {
    await command.handler(res, args);
  } catch (error) {
    log.error("Slash command processing failed", {
      command: command.name,
      ...serializeError(error)
    });
    sendAssistantResult(res, "Ghost server failed while processing command.");
  }
};

const toSessionTimestamp = (
  value: string | Date | undefined,
  fallbackPath: string,
  kind: "created" | "modified"
): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const stats = statSync(fallbackPath);
  return (kind === "created" ? stats.birthtime : stats.mtime).toISOString();
};

const toSessionInfo = (entry: SessionManagerEntry): SessionInfo => ({
  id: basename(entry.path, ".jsonl"),
  name: entry.name ?? null,
  path: entry.path,
  createdAt: toSessionTimestamp(entry.created, entry.path, "created"),
  lastActiveAt: toSessionTimestamp(entry.modified, entry.path, "modified")
});

const loadSessionNames = (): Record<string, string> => {
  try {
    if (existsSync(SESSION_NAMES_PATH)) {
      return JSON.parse(readFileSync(SESSION_NAMES_PATH, "utf-8")) as Record<string, string>;
    }
  } catch {}
  return {};
};

const saveSessionNames = (names: Record<string, string>): void => {
  writeFileSync(SESSION_NAMES_PATH, JSON.stringify(names, null, 2));
};

export const createGhostHandlers = ({
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
  getSession,
  setSession,
  getSessionManager,
  setSessionManager,
  createManagedSession,
  getCurrentModelValue,
  getRuntimeMeta,
  nudges,
  nudgeEvents,
  listScheduleOperation,
  createScheduleOperation,
  deleteScheduleOperation
}: GhostHandlersDependencies) => {
  const handleSteer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await parseJsonRequestBodyOrRespond<unknown>(req, res);
    if (body === undefined) {
      return;
    }

    const requestBody =
      typeof body === "object" && body !== null ? (body as { prompt?: unknown; images?: unknown }) : {};

    if (typeof requestBody.prompt !== "string") {
      sendJsonError(res, 400, "Missing prompt");
      return;
    }

    const { images, error } = parseRequestImages(requestBody.images);
    if (error) {
      sendJsonError(res, 400, error);
      return;
    }

    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi steer failed",
      async () => {
        const session = getSession();
        await session.steer(requestBody.prompt as string, toPiPromptImages(images));
        return {
          body: {
            status: "queued",
            pendingCount: session.pendingMessageCount
          }
        };
      },
      "Steer failed"
    );
  };

  const handleQueue = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi queue failed",
      () => {
        const session = getSession();
        const queueState = {
          steering: session.getSteeringMessages(),
          followUp: session.getFollowUpMessages(),
          pendingCount: session.pendingMessageCount
        } satisfies GhostQueueState;

        return { body: queueState };
      },
      "Queue failed"
    );
  };

  const handleClearQueue = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi clear queue failed",
      () => {
        const cleared = getSession().clearQueue();
        return { body: { cleared } };
      },
      "Clear queue failed"
    );
  };

  const handleMessage = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await parseJsonRequestBodyOrRespond<unknown>(req, res);
    if (body === undefined) {
      return;
    }

    const requestBody =
      typeof body === "object" && body !== null
        ? (body as {
            prompt?: unknown;
            model?: unknown;
            images?: unknown;
            streamingBehavior?: unknown;
          })
        : {};

    const prompt = requestBody.prompt;
    const model = typeof requestBody.model === "string" ? requestBody.model : undefined;
    const streamingBehaviorValue = requestBody.streamingBehavior;

    if (typeof prompt !== "string") {
      sendJsonError(res, 400, "Missing prompt");
      return;
    }

    if (streamingBehaviorValue !== undefined && !isStreamingBehavior(streamingBehaviorValue)) {
      sendJsonError(res, 400, "Invalid streamingBehavior");
      return;
    }

    const { images, error } = parseRequestImages(requestBody.images);
    if (error) {
      sendJsonError(res, 400, error);
      return;
    }

    const slashCommand = parseSlashCommandPrompt(prompt);
    if (slashCommand) {
      const handler = slashCommands.get(slashCommand.command);
      if (handler) {
        await runQueued(() =>
          streamSlashCommand(
            res,
            handler,
            slashCommand.args,
            startNdjsonResponse,
            sendAssistantResult,
            log,
            serializeError
          )
        );
        return;
      }
    }

    if (streamingBehaviorValue) {
      await streamPrompt(res, prompt, model, images, streamingBehaviorValue);
      return;
    }

    await runQueued(() => streamPrompt(res, prompt, model, images));
  };

  const handleReload = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi reload failed",
      async () => {
        const session = getSession();
        log.info("Pi reload start", { sessionId: session.sessionId });
        await runQueued(() => session.reload());
        log.info("Pi reload complete", { sessionId: session.sessionId });
        return { body: { status: "reloaded" } };
      },
      "Reload failed"
    );
  };

  const handleSessions = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi sessions failed",
      async () => {
        const sessions = (await SessionManager.list("/vault")) as SessionManagerEntry[];
        const names = loadSessionNames();
        const session = getSession();
        const sessionManager = getSessionManager();
        const currentId = basename(sessionManager.getSessionFile() ?? "", ".jsonl") || session.sessionId;
        const response = {
          current: currentId,
          sessions: sessions.map((entry) => {
            const info = toSessionInfo(entry);
            const storedName = names[info.id];
            if (storedName) {
              info.name = storedName;
            }
            return info;
          })
        } satisfies SessionListResponse;

        return { body: response };
      },
      "Sessions failed"
    );
  };

  const handleSwitchSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await parseJsonRequestBodyOrRespond<unknown>(req, res);
    if (body === undefined) {
      return;
    }

    const sessionId =
      typeof body === "object" && body !== null && typeof (body as { sessionId?: unknown }).sessionId === "string"
        ? (body as { sessionId: string }).sessionId.trim()
        : "";

    if (!sessionId) {
      sendJsonError(res, 400, "Missing sessionId");
      return;
    }

    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi switch session failed",
      async () => {
        const sessions = (await SessionManager.list("/vault")) as SessionManagerEntry[];
        const nextSessionInfo = sessions.find((entry) => basename(entry.path, ".jsonl") === sessionId);

        if (!nextSessionInfo) {
          return {
            status: 404,
            body: { error: `Session "${sessionId}" not found` }
          };
        }

        await runQueued(async () => {
          const nextSessionManager = SessionManager.open(nextSessionInfo.path);
          const nextSession = await createManagedSession(nextSessionManager);
          setSessionManager(nextSessionManager);
          setSession(nextSession);
          nudges.resetCounters();
        });

        return { body: { status: "switched", sessionId: getSession().sessionId } };
      },
      "Switch session failed"
    );
  };

  const handleRenameSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await parseJsonRequestBodyOrRespond<unknown>(req, res);
    if (body === undefined) {
      return;
    }

    const sessionId =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).sessionId === "string"
        ? (body as Record<string, string>).sessionId.trim()
        : "";
    const name =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).name === "string"
        ? (body as Record<string, string>).name.trim()
        : "";

    if (!sessionId) {
      sendJsonError(res, 400, "Missing sessionId");
      return;
    }

    const names = loadSessionNames();
    if (name) {
      names[sessionId] = name;
    } else {
      delete names[sessionId];
    }
    saveSessionNames(names);

    sendJson(res, 200, { status: "renamed", sessionId, name: name || null });
  };

  const handleDeleteSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.url?.replace("/sessions/", "").trim() ?? "";

    if (!sessionId) {
      sendJsonError(res, 400, "Missing sessionId");
      return;
    }

    const session = getSession();
    const sessionManager = getSessionManager();
    if (session.sessionId === sessionId || basename(sessionManager.getSessionFile() ?? "", ".jsonl") === sessionId) {
      sendJsonError(res, 409, "Cannot delete the active session");
      return;
    }

    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi delete session failed",
      async () => {
        const sessions = (await SessionManager.list("/vault")) as SessionManagerEntry[];
        const target = sessions.find((entry) => basename(entry.path, ".jsonl") === sessionId);

        if (!target) {
          return {
            status: 404,
            body: { error: `Session "${sessionId}" not found` }
          };
        }

        unlinkSync(target.path);

        const names = loadSessionNames();
        delete names[sessionId];
        saveSessionNames(names);

        return { body: { status: "deleted", sessionId } };
      },
      "Delete session failed"
    );
  };

  const handleTimeline = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi timeline failed",
      () => {
        const request = parseTimelineRequest(req);
        const sessionManager = getSessionManager();
        const entries = getSessionEntries(sessionManager);
        return {
          body: paginateTimelineItems(buildTimelineItems(entries, getHistoryMessages), request.before, request.limit)
        };
      },
      "Timeline failed"
    );
  };

  const handleCompact = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi compact failed",
      async () => {
        const session = getSession();
        log.info("Pi compact start", { sessionId: session.sessionId });
        await runQueued(async () => {
          await nudges.emit("pre-compact", "api");
          await getSession().compact();
          await getSession().reload();
        });
        log.info("Pi compact complete", { sessionId: getSession().sessionId });
        return { body: { status: "compacted" } };
      },
      "Compaction failed"
    );
  };

  const handleStats = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi stats failed",
      () => {
        const session = getSession();
        const stats = session.getSessionStats();
        const contextUsage = session.getContextUsage();

        return {
          body: {
            sessionId: session.sessionId,
            model: getCurrentModelValue(),
            tokens: stats.tokens,
            cost: stats.cost,
            messageCount: stats.totalMessages,
            context: contextUsage
              ? {
                  used: contextUsage.tokens,
                  window: contextUsage.contextWindow,
                  percent: contextUsage.percent
                }
              : null
          }
        };
      },
      "Stats failed"
    );
  };

  const handleScheduleGet = async (): Promise<JsonHandlerResult> => {
    const result = await listScheduleOperation();
    return { body: result.data };
  };

  const handleSchedulePost = async (req: IncomingMessage): Promise<JsonHandlerResult> => {
    const body = await parseJsonRequestBody<unknown>(req);
    const input =
      typeof body === "object" && body !== null
        ? (body as { cron?: string; prompt?: string; once?: boolean; timezone?: string })
        : {};
    const result = await createScheduleOperation(input, { validate: false });
    return { status: 201, body: result.data };
  };

  const handleScheduleDelete = async (req: IncomingMessage): Promise<JsonHandlerResult> => {
    const scheduleId = req.url?.replace("/schedules/", "").trim() ?? "";
    if (!scheduleId) {
      return { status: 400, body: { error: "Missing schedule id" } };
    }

    const result = await deleteScheduleOperation(scheduleId);
    return { body: result.data };
  };

  const handleSchedules = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi schedules failed",
      async () => {
        switch (req.method) {
          case "GET":
            return handleScheduleGet();
          case "POST":
            return handleSchedulePost(req);
          case "DELETE":
            return handleScheduleDelete(req);
          default:
            return { status: 405, body: { error: "Method not allowed" } };
        }
      },
      "Schedules failed"
    );
  };

  const handleCommands = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi commands failed",
      () => ({ body: getRuntimeMeta().supportedCommands }),
      "Commands failed"
    );
  };

  const handleRuntimeMeta = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi runtime meta failed",
      () => ({ body: getRuntimeMeta() }),
      "Runtime meta failed"
    );
  };

  const handleNudgeStatus = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Nudge status failed",
      () => ({ body: nudges.status() }),
      "Nudge status failed"
    );
  };

  const handleNudge = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = await getRequestBody(req);
      const parsed = JSON.parse(body) as { event?: string; reason?: string };
      const event = parsed.event ?? "self";
      const reason = parsed.reason ?? "api-trigger";

      if (!isNudgeEvent(event, nudgeEvents)) {
        sendJson(res, 400, { error: `Invalid event: ${event}`, valid: nudgeEvents });
        return;
      }

      await nudges.emit(event, reason);
      sendJson(res, 200, { ok: true, event, reason });
    } catch (error) {
      log.error("Nudge endpoint failed", serializeError(error));
      sendJsonError(res, 500, "Nudge failed");
    }
  };

  const handleAbort = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi abort failed",
      async () => {
        const session = getSession();
        log.info("Pi abort start", { sessionId: session.sessionId });
        await session.abort();
        log.info("Pi abort complete", { sessionId: session.sessionId });
        return { body: { status: "aborted" } };
      },
      "Abort failed"
    );
  };

  const handleTaskKill = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    const taskKillMatch = pathname.match(/^\/tasks\/([^/]+)\/kill$/);

    if (!taskKillMatch) {
      sendJsonError(res, 404, "Not found");
      return;
    }

    const taskId = decodeURIComponent(taskKillMatch[1]);
    const killBackgroundTask = (globalThis as Record<string, unknown>).__ghostbox_kill_bg_task as
      | ((taskId: string) => { killed: boolean; taskId: string })
      | undefined;

    if (!killBackgroundTask) {
      sendJsonError(res, 404, "Background task extension not loaded");
      return;
    }

    const result = killBackgroundTask(taskId);
    if (!result.killed) {
      sendJsonError(res, 404, `Background task "${taskId}" not found`);
      return;
    }

    sendJson(res, 200, { status: "killed", taskId });
  };

  const handleNewSession = async (res: ServerResponse): Promise<void> => {
    await withJsonResponse(
      res,
      log,
      serializeError,
      "Pi new session failed",
      async () => {
        const session = getSession();
        log.info("Pi new session start", { sessionId: session.sessionId });
        await runQueued(async () => {
          await nudges.emit("pre-new-session", "api");
          await getSession().reload();
          await getSession().newSession();
          nudges.resetCounters();
        });
        void nudges.emit("session-start", "api-new").catch((error) => {
          log.error("Session-start nudge failed", serializeError(error));
        });
        log.info("Pi new session complete", { sessionId: getSession().sessionId });
        return { body: { status: "new_session", sessionId: getSession().sessionId } };
      },
      "New session failed"
    );
  };

  return {
    handleSteer,
    handleQueue,
    handleClearQueue,
    handleMessage,
    handleReload,
    handleSessions,
    handleSwitchSession,
    handleRenameSession,
    handleDeleteSession,
    handleTimeline,
    handleCompact,
    handleStats,
    handleSchedules,
    handleCommands,
    handleRuntimeMeta,
    handleNudgeStatus,
    handleNudge,
    handleAbort,
    handleTaskKill,
    handleNewSession
  };
};
