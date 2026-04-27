import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./logger";
import { getConfig, getGhost, loadState, saveState, steerGhost } from "./orchestrator";
import type {
  GhostboxConfig,
  GhostboxConfigResponse,
  GhostboxConfigSensitiveStatus,
  GhostboxConfigUpdate,
  GhostboxState,
  GhostImage,
  GhostStreamingBehavior,
  MailboxState,
  MailMessage
} from "./types";
import { getHomeDirectory } from "./utils";

type ApiStatusCode = 400 | 403 | 404;

export type ApiAuthContext = {
  authenticatedBy: string;
  ghostName: string | null;
};

export type LegacyConfig = GhostboxConfig & {
  defaultProvider?: string | null;
};

type MailSendBody = {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  priority?: unknown;
  threadId?: unknown;
};

type ConfigUpdateBody = GhostboxConfigUpdate & Record<string, unknown>;

type SendMailResult =
  | { rateLimited: true; retryAfter: number }
  | { rateLimited: false; response: { status: "sent"; id: string } };

const log = createLogger("api");

const MAIL_RATE_LIMIT_WINDOW_MS = 60_000;
const MAIL_RATE_LIMIT_MAX_MESSAGES = 10;
const MAIL_SUBJECT_MAX_LENGTH = 200;
const MAIL_BODY_MAX_LENGTH = 10_000;
const MAILBOX_MAX_MESSAGES_PER_RECIPIENT = 500;
const DEFAULT_CORS_ORIGINS = ["http://localhost:8008", "http://localhost:3000"];
const mailRateLimitState = new Map<string, { count: number; windowStart: number }>();

const createApiError = (status: ApiStatusCode, message: string): Error & { status: ApiStatusCode } => {
  const error = new Error(message) as Error & { status: ApiStatusCode };
  error.name = "ApiError";
  error.status = status;
  return error;
};

const getMailboxPath = (): string => join(getHomeDirectory(), ".ghostbox", "mailbox.json");

const getLegacyApiUserToken = (): string | null => {
  const configured = process.env.GHOSTBOX_MAIL_USER_TOKEN?.trim() || process.env.GHOSTBOX_ADMIN_TOKEN?.trim() || "";
  return configured || null;
};

const normalizeConfiguredOrigins = (origins: unknown): string[] => {
  if (!Array.isArray(origins)) {
    return [];
  }

  return Array.from(
    new Set(
      origins
        .filter((origin): origin is string => typeof origin === "string")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    )
  );
};

const parseCorsOriginsEnv = (): string[] => {
  const configured = process.env.GHOSTBOX_CORS_ORIGINS?.trim() || "";
  if (!configured) {
    return [];
  }

  return Array.from(
    new Set(
      configured
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    )
  );
};

export const resolveAllowedCorsOrigins = (config: GhostboxConfig): string[] => {
  const configuredOrigins = normalizeConfiguredOrigins(config.corsOrigins);
  const baseOrigins = configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_CORS_ORIGINS;

  return Array.from(new Set([...baseOrigins, ...parseCorsOriginsEnv()]));
};

const resolveConfigAdminToken = (config: GhostboxConfig): string | null => {
  const token = config.adminToken?.trim() || "";
  return token || null;
};

export const ensureApiAdminToken = async (): Promise<string> => {
  const state = await loadState();
  const existingToken = resolveConfigAdminToken(state.config);

  if (existingToken) {
    if (state.config.adminToken !== existingToken) {
      state.config.adminToken = existingToken;
      await saveState(state);
    }

    return existingToken;
  }

  const adminToken = randomBytes(32).toString("hex");
  state.config.adminToken = adminToken;
  await saveState(state);
  log.info({ adminToken }, "Generated API admin token");
  return adminToken;
};

const findGhostNameByApiKey = (state: GhostboxState, token: string): string | null => {
  for (const [ghostName, ghost] of Object.entries(state.ghosts)) {
    if (ghost.apiKeys.some((apiKey) => apiKey.key === token)) {
      return ghostName;
    }
  }

  return null;
};

const extractBearerToken = (authorizationHeader: string | undefined): string | null => {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1]?.trim();
  return token || null;
};

export const authenticateApiToken = async (authorizationHeader: string | undefined): Promise<ApiAuthContext | null> => {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return null;
  }

  const state = await loadState();
  const ghostName = findGhostNameByApiKey(state, token);

  if (ghostName) {
    return {
      authenticatedBy: ghostName,
      ghostName
    };
  }

  if (token === resolveConfigAdminToken(state.config)) {
    return {
      authenticatedBy: "user",
      ghostName: null
    };
  }

  if (token === getLegacyApiUserToken()) {
    return {
      authenticatedBy: "user",
      ghostName: null
    };
  }

  return null;
};

const hasConfigValue = (value: string | null | undefined): boolean => {
  return typeof value === "string" && value.length > 0;
};

const maskSensitiveConfigValue = (value: string | null | undefined): string => {
  if (!hasConfigValue(value)) {
    return "";
  }

  const sensitiveValue = value as string;
  const prefix = sensitiveValue.slice(0, 12);
  const suffix = sensitiveValue.slice(-4);
  return `${prefix}...${suffix}`;
};

const toConfigSensitiveStatus = (config: GhostboxConfig): GhostboxConfigSensitiveStatus => {
  return {
    githubToken: hasConfigValue(config.githubToken),
    telegramToken: hasConfigValue(config.telegramToken)
  };
};

export const toConfigResponse = (config: GhostboxConfig): GhostboxConfigResponse => {
  const { adminToken: _adminToken, ...publicConfig } = config;

  return {
    ...publicConfig,
    githubToken: maskSensitiveConfigValue(config.githubToken),
    telegramToken: maskSensitiveConfigValue(config.telegramToken),
    hasSensitive: toConfigSensitiveStatus(config)
  };
};

const normalizeRequiredConfigValue = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw createApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw createApiError(400, `Missing ${field}`);
  }

  return trimmed;
};

const normalizeNullableConfigValue = (value: unknown, field: string): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw createApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeSensitiveConfigValue = (
  value: unknown,
  field: "githubToken" | "telegramToken"
): string | null | undefined => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw createApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("...")) {
    return undefined;
  }

  return trimmed;
};

export const updateStoredConfig = async (body: ConfigUpdateBody): Promise<GhostboxConfigResponse> => {
  const state = await loadState();
  const nextConfig = { ...state.config };

  if ("defaultProvider" in body) {
    nextConfig.defaultProvider = normalizeRequiredConfigValue(body.defaultProvider, "defaultProvider");
  }

  if ("defaultModel" in body) {
    nextConfig.defaultModel = normalizeRequiredConfigValue(body.defaultModel, "defaultModel");
  }

  if ("imageName" in body) {
    nextConfig.imageName = normalizeRequiredConfigValue(body.imageName, "imageName");
  }

  if ("githubRemote" in body) {
    nextConfig.githubRemote = normalizeNullableConfigValue(body.githubRemote, "githubRemote");
  }

  if ("githubToken" in body) {
    const githubToken = normalizeSensitiveConfigValue(body.githubToken, "githubToken");
    if (githubToken === null) {
      nextConfig.githubToken = null;
    } else if (typeof githubToken === "string") {
      nextConfig.githubToken = githubToken;
    }
  }

  if ("telegramToken" in body) {
    const telegramToken = normalizeSensitiveConfigValue(body.telegramToken, "telegramToken");
    if (telegramToken === null) {
      nextConfig.telegramToken = "";
    } else if (typeof telegramToken === "string") {
      nextConfig.telegramToken = telegramToken;
    }
  }

  state.config = nextConfig;
  await saveState(state);

  return toConfigResponse(nextConfig);
};

export const normalizeGhostImages = (value: unknown): GhostImage[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw createApiError(400, "Invalid images");
  }

  return value.map((image) => {
    if (typeof image !== "object" || image === null) {
      throw createApiError(400, "Invalid images");
    }

    const { mediaType, data } = image as {
      mediaType?: unknown;
      data?: unknown;
    };

    if (typeof mediaType !== "string" || typeof data !== "string") {
      throw createApiError(400, "Invalid images");
    }

    return { mediaType, data };
  });
};

export const normalizeStreamingBehavior = (value: unknown): GhostStreamingBehavior | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === "steer" || value === "followUp") {
    return value;
  }

  throw createApiError(400, "Invalid streamingBehavior");
};

const normalizeMailTextField = (value: unknown, field: "from" | "to" | "subject" | "body"): string => {
  if (typeof value !== "string") {
    throw createApiError(400, `Missing ${field}`);
  }

  if (field === "body") {
    if (!value.trim()) {
      throw createApiError(400, "Missing body");
    }

    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw createApiError(400, `Missing ${field}`);
  }

  return trimmed;
};

const normalizeMailPriority = (value: unknown): "normal" | "urgent" => {
  if (value === undefined) {
    return "normal";
  }

  if (value === "normal" || value === "urgent") {
    return value;
  }

  throw createApiError(400, "Invalid priority");
};

const normalizeMailThreadId = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw createApiError(400, "Invalid threadId");
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeStoredMailMessage = (value: unknown): MailMessage => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Mailbox file contains an invalid message");
  }

  const message = value as Partial<MailMessage>;

  if (
    typeof message.id !== "string" ||
    typeof message.from !== "string" ||
    typeof message.to !== "string" ||
    typeof message.subject !== "string" ||
    typeof message.body !== "string" ||
    typeof message.sentAt !== "string" ||
    (message.readAt !== null && typeof message.readAt !== "string") ||
    (message.threadId !== null && typeof message.threadId !== "string") ||
    (message.priority !== "normal" && message.priority !== "urgent")
  ) {
    throw new Error("Mailbox file contains an invalid message");
  }

  return {
    id: message.id,
    from: message.from,
    authenticatedBy: typeof message.authenticatedBy === "string" ? message.authenticatedBy : null,
    to: message.to,
    subject: message.subject,
    body: message.body,
    sentAt: message.sentAt,
    readAt: message.readAt,
    threadId: message.threadId,
    priority: message.priority
  };
};

const parseMailboxState = (value: unknown): MailboxState => {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { messages?: unknown }).messages)) {
    throw new Error("Mailbox file must contain a messages array");
  }

  return {
    messages: (value as { messages: unknown[] }).messages.map((message) => normalizeStoredMailMessage(message))
  };
};

const pruneMailboxMessagesForRecipient = (messages: MailMessage[], recipient: string): MailMessage[] => {
  const recipientMessages = messages.filter((message) => message.to === recipient);

  if (recipientMessages.length <= MAILBOX_MAX_MESSAGES_PER_RECIPIENT) {
    return messages;
  }

  const overflowCount = recipientMessages.length - MAILBOX_MAX_MESSAGES_PER_RECIPIENT;
  const oldestFirst = (left: MailMessage, right: MailMessage) => Date.parse(left.sentAt) - Date.parse(right.sentAt);
  const removableMessages = [
    ...recipientMessages.filter((message) => message.readAt !== null).sort(oldestFirst),
    ...recipientMessages.filter((message) => message.readAt === null).sort(oldestFirst)
  ];
  const removedIds = new Set(removableMessages.slice(0, overflowCount).map((message) => message.id));

  return messages.filter((message) => !removedIds.has(message.id));
};

const applyMailboxCaps = (mailboxState: MailboxState): MailboxState => {
  let messages = mailboxState.messages.map((message) => ({
    ...message,
    authenticatedBy: message.authenticatedBy ?? null
  }));

  for (const recipient of new Set(messages.map((message) => message.to))) {
    messages = pruneMailboxMessagesForRecipient(messages, recipient);
  }

  return { messages };
};

const validateMailSize = (subject: string, body: string): void => {
  if (subject.length > MAIL_SUBJECT_MAX_LENGTH) {
    throw createApiError(400, `Subject exceeds ${MAIL_SUBJECT_MAX_LENGTH} characters`);
  }

  if (body.length > MAIL_BODY_MAX_LENGTH) {
    throw createApiError(400, `Body exceeds ${MAIL_BODY_MAX_LENGTH} characters`);
  }
};

const resolveAuthenticatedMailSender = (
  requestedFrom: unknown,
  auth: ApiAuthContext
): Pick<MailMessage, "from" | "authenticatedBy"> => {
  const normalizedFrom =
    requestedFrom === undefined
      ? undefined
      : (() => {
          if (typeof requestedFrom !== "string") {
            throw createApiError(400, "Invalid from");
          }

          const trimmed = requestedFrom.trim();
          if (!trimmed) {
            throw createApiError(400, "Missing from");
          }

          return trimmed;
        })();

  if (normalizedFrom === "user") {
    return {
      from: "user",
      authenticatedBy: auth.authenticatedBy
    };
  }

  if (auth.ghostName) {
    return {
      from: auth.ghostName,
      authenticatedBy: auth.authenticatedBy
    };
  }

  if (normalizedFrom !== undefined) {
    throw createApiError(403, "User token can only send mail from user");
  }

  return {
    from: "user",
    authenticatedBy: auth.authenticatedBy
  };
};

const checkMailSendRateLimit = (sender: string): number | null => {
  const now = Date.now();
  const current = mailRateLimitState.get(sender);

  if (!current || now - current.windowStart >= MAIL_RATE_LIMIT_WINDOW_MS) {
    mailRateLimitState.set(sender, { count: 1, windowStart: now });
    return null;
  }

  if (current.count >= MAIL_RATE_LIMIT_MAX_MESSAGES) {
    return Math.max(1, Math.ceil((current.windowStart + MAIL_RATE_LIMIT_WINDOW_MS - now) / 1000));
  }

  current.count += 1;
  return null;
};

const canAccessMailMessage = (message: MailMessage, ghostName: string | null): boolean => {
  if (!ghostName) {
    return false;
  }

  return message.to === ghostName || message.to === "all";
};

const loadMailboxState = async (): Promise<MailboxState> => {
  const mailboxFile = Bun.file(getMailboxPath());

  if (!(await mailboxFile.exists())) {
    return { messages: [] };
  }

  const contents = await mailboxFile.text();
  if (!contents.trim()) {
    return { messages: [] };
  }

  return parseMailboxState(JSON.parse(contents) as unknown);
};

const saveMailboxState = async (mailboxState: MailboxState): Promise<void> => {
  const nextMailboxState = applyMailboxCaps(mailboxState);
  await mkdir(dirname(getMailboxPath()), { recursive: true });
  await Bun.write(getMailboxPath(), `${JSON.stringify(nextMailboxState, null, 2)}\n`);
};

export const sendMail = async (body: MailSendBody, auth: ApiAuthContext): Promise<SendMailResult> => {
  const { from, authenticatedBy } = resolveAuthenticatedMailSender(body.from, auth);
  const to = normalizeMailTextField(body.to, "to");
  const subject = normalizeMailTextField(body.subject, "subject");
  const mailBody = normalizeMailTextField(body.body, "body");
  const priority = normalizeMailPriority(body.priority);
  const threadId = normalizeMailThreadId(body.threadId);

  validateMailSize(subject, mailBody);

  const retryAfter = checkMailSendRateLimit(auth.authenticatedBy);
  if (retryAfter !== null) {
    return { rateLimited: true, retryAfter };
  }

  const message: MailMessage = {
    id: randomUUID(),
    from,
    authenticatedBy,
    to,
    subject,
    body: mailBody,
    priority,
    threadId,
    sentAt: new Date().toISOString(),
    readAt: null
  };

  const mailboxState = await loadMailboxState();
  mailboxState.messages.push(message);
  await saveMailboxState(mailboxState);

  if (priority === "urgent") {
    try {
      const ghost = await getGhost(to);
      if (ghost.status === "running") {
        await steerGhost(to, `You have an urgent message from ${from}. Use mailbox(action: "check") to read it.`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("not found")) {
        throw error;
      }
    }
  }

  return { rateLimited: false, response: { status: "sent", id: message.id } };
};

export const listMail = async (
  ghostName: string,
  unreadOnly: boolean,
  auth: ApiAuthContext
): Promise<{ messages: MailMessage[] }> => {
  const mailboxState = await loadMailboxState();

  if (auth.ghostName !== ghostName) {
    throw createApiError(403, "Forbidden");
  }

  const messages = mailboxState.messages
    .filter((message) => message.to === ghostName || message.to === "all")
    .filter((message) => !unreadOnly || message.readAt === null)
    .sort((left, right) => {
      if ((left.readAt === null) !== (right.readAt === null)) {
        return left.readAt === null ? -1 : 1;
      }

      return Date.parse(right.sentAt) - Date.parse(left.sentAt);
    });

  return { messages };
};

export const markMailRead = async (id: string, auth: ApiAuthContext): Promise<{ status: "read" }> => {
  const mailboxState = await loadMailboxState();
  const message = mailboxState.messages.find((entry) => entry.id === id);

  if (!message) {
    throw createApiError(404, `Mail message "${id}" not found.`);
  }

  if (!canAccessMailMessage(message, auth.ghostName)) {
    throw createApiError(403, "Forbidden");
  }

  message.readAt = new Date().toISOString();
  await saveMailboxState(mailboxState);

  return { status: "read" };
};

export const deleteMail = async (id: string, auth: ApiAuthContext): Promise<{ status: "deleted" }> => {
  const mailboxState = await loadMailboxState();
  const message = mailboxState.messages.find((entry) => entry.id === id);

  if (!message) {
    throw createApiError(404, `Mail message "${id}" not found.`);
  }

  if (!canAccessMailMessage(message, auth.ghostName)) {
    throw createApiError(403, "Forbidden");
  }

  const nextMessages = mailboxState.messages.filter((entry) => entry.id !== id);
  await saveMailboxState({ messages: nextMessages });

  return { status: "deleted" };
};

export const getPublicConfig = async (): Promise<GhostboxConfigResponse> => {
  return toConfigResponse(await getConfig());
};
