import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type LogContext = Record<string, unknown>;

type Logger = {
  info: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
};

type GhostMemoryMessage = {
  role?: string;
  content?: unknown;
};

type GhostMemorySession = {
  messages: GhostMemoryMessage[];
  sessionId: string;
  prompt: (prompt: string) => Promise<unknown>;
};

type AuthEntry = {
  type: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

type ObserverOperation = {
  action: "add" | "replace" | "remove";
  target: "memory" | "user";
  content?: string;
  old_text?: string;
};

const observerSystemPrompt = `You are a memory extraction agent. Your job: review conversation and extract facts that should persist across sessions.

Two stores:
- "memory": Agent's notes (environment, conventions, tool quirks, file references, lessons learned, project state)
- "user": User profile (preferences, role, communication style, corrections, expertise level)

EXTRACTION PROCESS:
1. Read the current memory contents provided below
2. Read the conversation
3. For each of these categories, check if the conversation reveals anything new:
   a. USER CORRECTIONS - Did the user correct something? (HIGHEST priority - prevents repeat mistakes)
   b. USER PREFERENCES - Did the user state how they want things done?
   c. ENVIRONMENT FACTS - Tech stack, tools, OS, paths, configs mentioned?
   d. PROJECT STATE - Decisions made, features shipped, bugs found, architecture choices?
   e. FILE REFERENCES - Important files created/modified that future sessions should know about?
   f. LESSONS LEARNED - Something that didn't work, or a non-obvious solution that did?
4. For each fact found: is it already in memory? If yes, does it need updating? If no, add it.
5. Is anything in current memory now WRONG based on the conversation? Remove or replace it.

SKIP: Task progress, temporary state, things easily re-discovered, raw data dumps, session-specific ephemera.

Output a JSON array of operations:
[{"action":"add","target":"memory","content":"fact to save"}]
[{"action":"replace","target":"memory","old_text":"unique substring","content":"updated text"}]
[{"action":"remove","target":"user","old_text":"unique substring to delete"}]

If nothing worth saving: []
Output ONLY the JSON array, no markdown, no explanation.`;

const observerModelEnv = process.env.GHOSTBOX_OBSERVER_MODEL || "";

export const NUDGE_EVENTS = [
  "message-complete",
  "pre-compact",
  "pre-new-session",
  "idle",
  "timer",
  "self",
  "session-start"
] as const;

export type NudgeEvent = (typeof NUDGE_EVENTS)[number];

type NudgeContext = {
  reason: string;
  messageCount: number;
  sessionAge: number;
  payload?: Record<string, unknown>;
};

type NudgeHandler = {
  id: string;
  event: NudgeEvent | NudgeEvent[];
  handler: (event: NudgeEvent, context: NudgeContext) => Promise<void> | void;
  messageInterval?: number;
  timeInterval?: number;
  background?: boolean;
};

type GhostMemoryDependencies = {
  log: Logger;
  serializeError: (error: unknown) => LogContext;
  getContentText: (content: unknown) => string;
  getSession: () => GhostMemorySession;
};

type DefaultNudgeDependencies = {
  log: Logger;
  serializeError: (error: unknown) => LogContext;
  flushMemories: (reason: string) => Promise<void>;
  runMemoryObserver: (reason: string) => Promise<void>;
};

const readMemoryFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

const readAuthEntry = (provider: string): AuthEntry | null => {
  try {
    const raw = readFileSync("/root/.pi/agent/auth.json", "utf8");
    const auth = JSON.parse(raw) as Record<string, AuthEntry>;
    const entry = auth[provider];
    if (!entry?.access) return null;
    return entry;
  } catch {
    return null;
  }
};

const refreshAnthropicToken = async (entry: AuthEntry): Promise<string | null> => {
  if (Date.now() < entry.expires) {
    return entry.access;
  }

  try {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        refresh_token: entry.refresh
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    try {
      const raw = readFileSync("/root/.pi/agent/auth.json", "utf8");
      const auth = JSON.parse(raw) as Record<string, AuthEntry>;
      auth.anthropic.access = data.access_token;
      auth.anthropic.expires = Date.now() + (data.expires_in ?? 3600) * 1000;
      writeFileSync("/root/.pi/agent/auth.json", JSON.stringify(auth, null, 2));
    } catch {
      // Best effort
    }

    return data.access_token;
  } catch {
    return null;
  }
};

const callObserverAnthropic = async (
  token: string,
  model: string,
  system: string,
  user: string,
  log: Logger,
  serializeError: (error: unknown) => LogContext
): Promise<string | null> => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20"
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      log.error("Observer Anthropic API failed", { status: response.status });
      return null;
    }
    const data = (await response.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? null;
  } catch (error) {
    log.error("Observer Anthropic API error", serializeError(error));
    return null;
  }
};

const callObserverOpenAI = async (
  token: string,
  model: string,
  system: string,
  user: string,
  log: Logger,
  serializeError: (error: unknown) => LogContext
): Promise<string | null> => {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      log.error("Observer OpenAI API failed", { status: response.status });
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (error) {
    log.error("Observer OpenAI API error", serializeError(error));
    return null;
  }
};

const executeObserverOp = (
  op: ObserverOperation,
  log: Logger,
  serializeError: (error: unknown) => LogContext
): void => {
  try {
    const args: string[] = [];
    if (op.action === "add" && op.content && op.target) {
      args.push("add", op.target, op.content);
    } else if (op.action === "replace" && op.old_text && op.content && op.target) {
      args.push("replace", op.target, op.old_text, op.content);
    } else if (op.action === "remove" && op.old_text && op.target) {
      args.push("remove", op.target, op.old_text);
    } else {
      return;
    }
    execFileSync("/usr/local/bin/memory", args, { timeout: 5000 });
  } catch (error) {
    log.error("Observer memory op failed", {
      action: op.action,
      target: op.target,
      ...serializeError(error)
    });
  }
};

export class NudgeRegistry {
  private readonly log: Logger;
  private readonly serializeError: (error: unknown) => LogContext;
  private handlers: NudgeHandler[] = [];
  private messageCount = 0;
  private handlerMessageCounters: Map<string, number> = new Map();
  private handlerLastFired: Map<string, number> = new Map();
  private sessionStartTime = Date.now();

  constructor(log: Logger, serializeError: (error: unknown) => LogContext) {
    this.log = log;
    this.serializeError = serializeError;
  }

  register(handler: NudgeHandler): void {
    this.handlers.push(handler);
    this.handlerMessageCounters.set(handler.id, 0);
    this.handlerLastFired.set(handler.id, Date.now());
    this.log.info("Nudge: registered handler", { id: handler.id, event: handler.event });
  }

  resetCounters(): void {
    this.messageCount = 0;
    this.sessionStartTime = Date.now();
    for (const handler of this.handlers) {
      this.handlerMessageCounters.set(handler.id, 0);
      this.handlerLastFired.set(handler.id, Date.now());
    }
  }

  status(): {
    handlers: Array<{
      id: string;
      event: NudgeEvent | NudgeEvent[];
      messageInterval?: number;
      timeInterval?: number;
      background?: boolean;
    }>;
    messageCount: number;
    sessionAge: number;
    handlerCounters: Record<string, number>;
    handlerLastFired: Record<string, string>;
  } {
    const counters: Record<string, number> = {};
    const lastFired: Record<string, string> = {};
    for (const handler of this.handlers) {
      counters[handler.id] = this.handlerMessageCounters.get(handler.id) ?? 0;
      const ts = this.handlerLastFired.get(handler.id) ?? 0;
      lastFired[handler.id] = ts ? new Date(ts).toISOString() : "never";
    }
    return {
      handlers: this.handlers.map((handler) => ({
        id: handler.id,
        event: handler.event,
        messageInterval: handler.messageInterval,
        timeInterval: handler.timeInterval,
        background: handler.background
      })),
      messageCount: this.messageCount,
      sessionAge: Date.now() - this.sessionStartTime,
      handlerCounters: counters,
      handlerLastFired: lastFired
    };
  }

  async emit(event: NudgeEvent, reason: string): Promise<void> {
    if (event === "message-complete") {
      this.messageCount++;
    }

    const context: NudgeContext = {
      reason,
      messageCount: this.messageCount,
      sessionAge: Date.now() - this.sessionStartTime
    };

    for (const handler of this.handlers) {
      const events = Array.isArray(handler.event) ? handler.event : [handler.event];
      if (!events.includes(event)) {
        continue;
      }

      if (handler.messageInterval && event === "message-complete") {
        const count = (this.handlerMessageCounters.get(handler.id) ?? 0) + 1;
        this.handlerMessageCounters.set(handler.id, count);
        if (count < handler.messageInterval) {
          continue;
        }
        this.handlerMessageCounters.set(handler.id, 0);
      }

      if (handler.timeInterval) {
        const lastFired = this.handlerLastFired.get(handler.id) ?? 0;
        if (Date.now() - lastFired < handler.timeInterval) {
          continue;
        }
      }

      this.handlerLastFired.set(handler.id, Date.now());

      const criticalEvents: NudgeEvent[] = ["pre-compact", "pre-new-session"];
      const shouldAwait = !handler.background || criticalEvents.includes(event);

      if (shouldAwait) {
        try {
          await handler.handler(event, context);
        } catch (error) {
          this.log.error("Nudge: handler failed", {
            id: handler.id,
            event,
            ...this.serializeError(error)
          });
        }
      } else {
        Promise.resolve(handler.handler(event, context)).catch((error: unknown) => {
          this.log.error("Nudge: background handler failed", {
            id: handler.id,
            event,
            ...this.serializeError(error)
          });
        });
      }
    }
  }
}

export const createGhostMemory = ({
  log,
  serializeError,
  getContentText,
  getSession
}: GhostMemoryDependencies): {
  flushMemories: (reason: string) => Promise<void>;
  runMemoryObserver: (reason: string) => Promise<void>;
} => {
  const formatConversationForObserver = (messages: GhostMemoryMessage[]): string => {
    const lines: string[] = [];
    const maxChars = 30000;
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const role = message.role ?? "unknown";
      const text = getContentText(message.content);
      if (!text) {
        continue;
      }

      const line = `[${role}]: ${text}`;
      if (totalChars + line.length > maxChars) {
        break;
      }

      lines.unshift(line);
      totalChars += line.length;
    }

    return lines.join("\n\n");
  };

  const runMemoryObserver = async (reason: string): Promise<void> => {
    if (!observerModelEnv) {
      return;
    }

    const separatorIdx = observerModelEnv.indexOf("/");
    if (separatorIdx <= 0) {
      log.error("Observer: invalid model format, expected provider/model", { model: observerModelEnv });
      return;
    }

    const provider = observerModelEnv.slice(0, separatorIdx);
    const modelId = observerModelEnv.slice(separatorIdx + 1);

    log.info("Observer: starting", { reason, provider, model: modelId });

    const authKey = provider === "openai" ? "openai-codex" : provider;
    const authEntry = readAuthEntry(authKey);
    if (!authEntry) {
      log.info("Observer: no auth for provider, skipping", { provider: authKey });
      return;
    }

    const session = getSession();
    const conversationText = formatConversationForObserver(session.messages);
    if (!conversationText) {
      log.info("Observer: no conversation to review, skipping");
      return;
    }

    const currentMemory = readMemoryFile("/vault/MEMORY.md");
    const currentUser = readMemoryFile("/vault/USER.md");

    const userMessage = [
      "Current MEMORY.md:",
      currentMemory || "(empty)",
      "",
      "Current USER.md:",
      currentUser || "(empty)",
      "",
      "Conversation to review:",
      conversationText
    ].join("\n");

    let responseText: string | null = null;

    if (provider === "anthropic") {
      const token = await refreshAnthropicToken(authEntry);
      if (!token) {
        log.error("Observer: failed to get Anthropic token");
        return;
      }
      responseText = await callObserverAnthropic(token, modelId, observerSystemPrompt, userMessage, log, serializeError);
    } else if (provider === "openai") {
      responseText = await callObserverOpenAI(authEntry.access, modelId, observerSystemPrompt, userMessage, log, serializeError);
    } else {
      log.error("Observer: unsupported provider", { provider });
      return;
    }

    if (!responseText) {
      log.info("Observer: no response from model");
      return;
    }

    try {
      const cleaned = responseText
        .replace(/^```json?\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();
      const operations = JSON.parse(cleaned) as ObserverOperation[];

      if (!Array.isArray(operations)) {
        log.error("Observer: response is not an array");
        return;
      }

      if (operations.length === 0) {
        log.info("Observer: nothing to save");
        return;
      }

      let successCount = 0;
      for (const operation of operations) {
        if (operation.action && operation.target) {
          executeObserverOp(operation, log, serializeError);
          successCount++;
        }
      }

      log.info("Observer: complete", { reason, operations: successCount });
    } catch (error) {
      log.error("Observer: failed to parse response", {
        preview: responseText.slice(0, 300),
        ...serializeError(error)
      });
    }
  };

  const flushMemories = async (reason: string): Promise<void> => {
    const session = getSession();
    if (session.messages.length < 3) {
      log.info("Memory flush skipped - too few messages", { reason });
      return;
    }

    const flushPrompt =
      '[System: The session is being compressed. Save anything worth remembering using memory_write (target "memory" for facts, target "user" for user preferences). Prioritize user preferences, corrections, and recurring patterns over task-specific details. Do NOT respond conversationally - just save and stop.]';

    log.info("Memory flush start", {
      reason,
      sessionId: session.sessionId,
      messageCount: session.messages.length
    });

    try {
      await session.prompt(flushPrompt);

      log.info("Memory flush complete", {
        reason,
        sessionId: session.sessionId
      });
    } catch (error) {
      log.error("Memory flush failed", {
        reason,
        sessionId: session.sessionId,
        ...serializeError(error)
      });
    }

    const messages = session.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = getContentText(messages[i].content);
      if (text?.includes("[System: The session is being compressed")) {
        messages.splice(i);
        log.info("Memory flush artifacts stripped", { removedFrom: i });
        break;
      }
    }
  };

  return { flushMemories, runMemoryObserver };
};

export const registerDefaultNudgeHandlers = (
  nudges: NudgeRegistry,
  { log, serializeError, flushMemories, runMemoryObserver }: DefaultNudgeDependencies
): void => {
  nudges.register({
    id: "memory-observer",
    event: ["pre-compact", "pre-new-session"],
    handler: async (event, context) => {
      await flushMemories(`nudge:${event}:${context.reason}`);
    },
    background: true
  });

  nudges.register({
    id: "memory-observer-fallback",
    event: ["self", "timer"],
    handler: async (event, context) => {
      if (!context.reason.includes("memory")) {
        return;
      }
      await runMemoryObserver(`nudge:${event}:${context.reason}`);
    },
    background: true
  });

  void log;
  void serializeError;
};
