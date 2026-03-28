import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { createLogger } from "./logger";
import { getAuthStatus } from "./oauth";
import {
  abortGhost,
  clearGhostQueue,
  compactGhost,
  deleteGhostSession,
  generateApiKey,
  getConfig,
  getGhost,
  getGhostHealth,
  getGhostHistory,
  getGhostQueue,
  getGhostSessions,
  getGhostStats,
  killGhost,
  listApiKeys,
  listGhosts,
  loadState,
  mergeGhosts,
  newGhostSession,
  reconcileGhostStates,
  reloadGhost,
  removeGhost,
  renameGhostSession,
  revokeApiKey,
  saveState,
  sendMessage,
  spawnGhost,
  steerGhost,
  switchGhostSession,
  updateGhost,
  wakeGhost
} from "./orchestrator";
import type {
  GhostboxConfig,
  GhostboxConfigResponse,
  GhostboxConfigSensitiveStatus,
  GhostboxConfigUpdate,
  GhostboxState,
  GhostImage,
  GhostSchedule,
  GhostStreamingBehavior,
  MailboxState,
  MailMessage,
  VaultEntry
} from "./types";
import { getHomeDirectory, isNodeError } from "./utils";
import { commitVault, getVaultPath } from "./vault";

const DEFAULT_PORT = 8008;
const port = Number(process.env.GHOSTBOX_PORT) || DEFAULT_PORT;
const log = createLogger("api");

type ApiAuthContext = {
  authenticatedBy: string;
  ghostName: string | null;
};

const app = new Hono<{
  Variables: {
    apiAuth: ApiAuthContext;
  };
}>();

type ApiStatusCode = 400 | 401 | 403 | 404 | 409 | 429 | 500;

class ApiError extends Error {
  status: ApiStatusCode;

  constructor(status: ApiStatusCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type SpawnBody = {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
};

type UpdateGhostBody = {
  model?: unknown;
  provider?: unknown;
} & Record<string, unknown>;

type MessageBody = {
  prompt?: unknown;
  model?: unknown;
  images?: unknown;
  streamingBehavior?: unknown;
};

type SteerBody = {
  prompt?: unknown;
  images?: unknown;
};

type GenerateKeyBody = {
  label?: unknown;
};

type MergeBody = {
  target?: unknown;
};

type VaultWriteBody = {
  path?: unknown;
  content?: unknown;
};

type VaultDeleteBody = {
  path?: unknown;
};

type SessionSwitchBody = {
  sessionId?: unknown;
};

type MailSendBody = {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  priority?: unknown;
  threadId?: unknown;
};

type ScheduleCreateBody = {
  cron?: unknown;
  prompt?: unknown;
  timezone?: unknown;
  once?: unknown;
};

type ConfigUpdateBody = GhostboxConfigUpdate & Record<string, unknown>;

type LegacyConfig = GhostboxConfig & {
  defaultProvider?: string | null;
};

type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

type ParsedCronField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = Record<CronFieldName, ParsedCronField>;

const CRON_WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

const CRON_FIELD_RANGES: Array<{ name: CronFieldName; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 }
];

const SYSTEM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const MAX_CRON_SEARCH_MINUTES = 366 * 24 * 60;
const MAIL_RATE_LIMIT_WINDOW_MS = 60_000;
const MAIL_RATE_LIMIT_MAX_MESSAGES = 10;
const MAIL_SUBJECT_MAX_LENGTH = 200;
const MAIL_BODY_MAX_LENGTH = 10_000;
const MAILBOX_MAX_MESSAGES_PER_RECIPIENT = 500;
const DEFAULT_CORS_ORIGINS = ["http://localhost:8008", "http://localhost:3000"];
const mailRateLimitState = new Map<string, { count: number; windowStart: number }>();

const getSchedulePath = (): string => resolve(getHomeDirectory(), ".ghostbox", "schedules.json");
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

const resolveAllowedCorsOrigins = (config: GhostboxConfig): string[] => {
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

const normalizeScheduleTimezone = (value: unknown): string => {
  if (value === undefined) {
    return SYSTEM_TIMEZONE;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, "Invalid timezone");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return SYSTEM_TIMEZONE;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    throw new ApiError(400, "Invalid timezone");
  }
};

const normalizeSchedulePrompt = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ApiError(400, "Missing prompt");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, "Missing prompt");
  }

  return trimmed;
};

const normalizeScheduleCron = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ApiError(400, "Missing cron");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, "Missing cron");
  }

  return trimmed;
};

const normalizeScheduleOnce = (value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new ApiError(400, "Invalid once");
  }

  return value;
};

const parseCronNumber = (token: string, min: number, max: number, fieldName: CronFieldName): number => {
  const value = Number(token);
  if (!Number.isInteger(value)) {
    throw new ApiError(400, `Invalid cron field: ${fieldName}`);
  }

  if (fieldName === "dayOfWeek" && value === 7) {
    return 0;
  }

  if (value < min || value > max) {
    throw new ApiError(400, `Invalid cron field: ${fieldName}`);
  }

  return value;
};

const expandCronSegment = (token: string, min: number, max: number, fieldName: CronFieldName): number[] => {
  const [rangePart, stepPart] = token.split("/");
  const step = stepPart === undefined ? 1 : Number(stepPart);

  if (!Number.isInteger(step) || step <= 0) {
    throw new ApiError(400, `Invalid cron field: ${fieldName}`);
  }

  let start = min;
  let end = max;

  if (rangePart !== "*") {
    if (rangePart.includes("-")) {
      const [startToken, endToken] = rangePart.split("-");
      if (!startToken || !endToken) {
        throw new ApiError(400, `Invalid cron field: ${fieldName}`);
      }

      start = parseCronNumber(startToken, min, max, fieldName);
      end = parseCronNumber(endToken, min, max, fieldName);

      if (start > end) {
        throw new ApiError(400, `Invalid cron field: ${fieldName}`);
      }
    } else {
      start = parseCronNumber(rangePart, min, max, fieldName);
      end = start;
    }
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(fieldName === "dayOfWeek" && value === 7 ? 0 : value);
  }
  return values;
};

const parseCronField = (rawField: string, fieldName: CronFieldName, min: number, max: number): ParsedCronField => {
  const field = rawField.trim();
  if (!field) {
    throw new ApiError(400, `Invalid cron field: ${fieldName}`);
  }

  const wildcard = field === "*";
  const values = new Set<number>();

  for (const segment of field.split(",")) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) {
      throw new ApiError(400, `Invalid cron field: ${fieldName}`);
    }

    for (const value of expandCronSegment(trimmedSegment, min, max, fieldName)) {
      values.add(value);
    }
  }

  return { values, wildcard };
};

const parseCronExpression = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ApiError(400, "Invalid cron");
  }

  return Object.fromEntries(
    CRON_FIELD_RANGES.map(({ name, min, max }, index) => [
      name,
      parseCronField(fields[index] as string, name, min, max)
    ])
  ) as ParsedCron;
};

const getZonedDateParts = (
  date: Date,
  timeZone: string
): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = CRON_WEEKDAY_MAP[values.weekday ?? ""];

  if (weekday === undefined) {
    throw new ApiError(400, "Invalid timezone");
  }

  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekday
  };
};

const cronMatchesDate = (parsedCron: ParsedCron, date: Date, timeZone: string): boolean => {
  const zoned = getZonedDateParts(date, timeZone);

  if (!parsedCron.minute.values.has(zoned.minute)) return false;
  if (!parsedCron.hour.values.has(zoned.hour)) return false;
  if (!parsedCron.month.values.has(zoned.month)) return false;

  const dayOfMonthMatches = parsedCron.dayOfMonth.values.has(zoned.dayOfMonth);
  const dayOfWeekMatches = parsedCron.dayOfWeek.values.has(zoned.dayOfWeek);

  if (parsedCron.dayOfMonth.wildcard && parsedCron.dayOfWeek.wildcard) {
    return true;
  }

  if (parsedCron.dayOfMonth.wildcard) {
    return dayOfWeekMatches;
  }

  if (parsedCron.dayOfWeek.wildcard) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
};

const getNextCronFire = (expression: string, timeZone: string, afterTimestamp: number): string => {
  const parsedCron = parseCronExpression(expression);
  const nextMinute = Math.floor(afterTimestamp / 60_000) * 60_000 + 60_000;

  for (let offset = 0; offset < MAX_CRON_SEARCH_MINUTES; offset++) {
    const candidate = new Date(nextMinute + offset * 60_000);
    if (cronMatchesDate(parsedCron, candidate, timeZone)) {
      return candidate.toISOString();
    }
  }

  throw new ApiError(400, "Cron does not produce a future run time");
};

type ScheduleDispatcher = (schedule: GhostSchedule) => Promise<void>;

export class ScheduleManager {
  private intervalId?: ReturnType<typeof setInterval>;
  private processing = false;
  private readonly dispatchSchedule: ScheduleDispatcher;

  constructor(dispatchSchedule: ScheduleDispatcher) {
    this.dispatchSchedule = dispatchSchedule;
  }

  private async loadSchedules(): Promise<GhostSchedule[]> {
    try {
      const contents = await readFile(getSchedulePath(), "utf8");
      const parsed = JSON.parse(contents) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Schedules file must contain an array");
      }
      return parsed as GhostSchedule[];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async saveSchedules(schedules: GhostSchedule[]): Promise<void> {
    await mkdir(dirname(getSchedulePath()), { recursive: true });
    await writeFile(getSchedulePath(), JSON.stringify(schedules, null, 2), "utf8");
  }

  async list(ghostName: string): Promise<GhostSchedule[]> {
    const schedules = await this.loadSchedules();
    return schedules.filter((schedule) => schedule.ghostName === ghostName);
  }

  async create(
    ghostName: string,
    input: { cron?: unknown; prompt?: unknown; timezone?: unknown; once?: unknown }
  ): Promise<GhostSchedule> {
    await getGhost(ghostName);

    const cron = normalizeScheduleCron(input.cron);
    const prompt = normalizeSchedulePrompt(input.prompt);
    const timezone = normalizeScheduleTimezone(input.timezone);
    const once = normalizeScheduleOnce(input.once);
    const now = Date.now();

    const schedule: GhostSchedule = {
      id: randomUUID(),
      ghostName,
      cron,
      prompt,
      timezone,
      once,
      enabled: true,
      createdAt: new Date(now).toISOString(),
      lastFired: null,
      nextFire: getNextCronFire(cron, timezone, now)
    };

    const schedules = await this.loadSchedules();
    schedules.push(schedule);
    await this.saveSchedules(schedules);
    return schedule;
  }

  async delete(ghostName: string, id: string): Promise<void> {
    const schedules = await this.loadSchedules();
    const nextSchedules = schedules.filter((schedule) => !(schedule.ghostName === ghostName && schedule.id === id));

    if (nextSchedules.length === schedules.length) {
      throw new ApiError(404, `Schedule "${id}" not found.`);
    }

    await this.saveSchedules(nextSchedules);
  }

  start(): void {
    if (this.intervalId) {
      return;
    }

    void this.processDueSchedules();
    this.intervalId = setInterval(() => {
      void this.processDueSchedules();
    }, 30_000);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (!this.intervalId) {
      return;
    }

    clearInterval(this.intervalId);
    this.intervalId = undefined;
  }

  async processDueSchedules(referenceTime = Date.now()): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      const schedules = await this.loadSchedules();
      const dueSchedules = schedules.filter(
        (schedule) =>
          schedule.enabled && typeof schedule.nextFire === "string" && Date.parse(schedule.nextFire) <= referenceTime
      );

      if (dueSchedules.length === 0) {
        return;
      }

      for (const schedule of dueSchedules) {
        try {
          log.info({ id: schedule.id, ghostName: schedule.ghostName }, "Firing scheduled prompt");
          await this.dispatchSchedule(schedule);
          schedule.lastFired = new Date(referenceTime).toISOString();
          if (schedule.once) {
            schedule.enabled = false;
            schedule.nextFire = null;
          } else {
            schedule.nextFire = getNextCronFire(schedule.cron, schedule.timezone, referenceTime);
          }
        } catch (error) {
          log.error({ err: error, scheduleId: schedule.id, ghostName: schedule.ghostName }, "Scheduled prompt failed");
        }
      }

      await this.saveSchedules(schedules);
    } finally {
      this.processing = false;
    }
  }
}

const ensureGhostExists = async (name: string): Promise<string> => {
  await getGhost(name);
  return resolve(getVaultPath(name));
};

const toVaultApiPath = (vaultPath: string, fullPath: string): string => {
  const nextRelativePath = relative(vaultPath, fullPath);
  if (!nextRelativePath) {
    return "/";
  }

  return `/${nextRelativePath.split(sep).join("/")}`;
};

const resolveVaultItemPath = async (
  ghostName: string,
  inputPath: string | undefined,
  options?: { allowRoot?: boolean }
): Promise<{ vaultPath: string; fullPath: string; apiPath: string }> => {
  const vaultPath = await ensureGhostExists(ghostName);
  const rawPath = inputPath?.trim() ?? "";
  const requestedPath = rawPath || "/";

  if (!rawPath && options?.allowRoot !== true) {
    throw new ApiError(400, "Missing path");
  }

  if (requestedPath.includes("..")) {
    throw new ApiError(400, "Invalid path");
  }

  const relativePath = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = resolve(vaultPath, relativePath);
  const vaultPrefix = vaultPath.endsWith(sep) ? vaultPath : `${vaultPath}${sep}`;

  if (fullPath !== vaultPath && !fullPath.startsWith(vaultPrefix)) {
    throw new ApiError(400, "Invalid path");
  }

  if (fullPath === vaultPath && options?.allowRoot !== true) {
    throw new ApiError(400, "Invalid path");
  }

  return {
    vaultPath,
    fullPath,
    apiPath: toVaultApiPath(vaultPath, fullPath)
  };
};

const getVaultEntryType = (stats: Awaited<ReturnType<typeof stat>>): VaultEntry["type"] => {
  return stats.isDirectory() ? "directory" : "file";
};

const readVaultEntries = async (vaultPath: string, directoryPath: string): Promise<VaultEntry[]> => {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolve(directoryPath, entry.name);
      const entryStats = await stat(entryPath);
      const entryType = getVaultEntryType(entryStats);

      return {
        name: entry.name,
        path: toVaultApiPath(vaultPath, entryPath),
        type: entryType,
        size: entryType === "file" ? entryStats.size : undefined,
        modified: entryStats.mtime.toISOString()
      } satisfies VaultEntry;
    })
  );

  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
};

const throwVaultFsError = (error: unknown): never => {
  if (isNodeError(error) && error.code === "ENOENT") {
    throw new ApiError(404, "Path not found");
  }

  throw error;
};

const parseProviderAndModel = (value: string): { provider: string | null; model: string } => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { provider: null, model: trimmed };
  }

  return {
    provider: trimmed.slice(0, separatorIndex).trim().toLowerCase(),
    model: trimmed.slice(separatorIndex + 1).trim()
  };
};

const getDefaultProvider = (config: LegacyConfig): string => {
  const parsed = parseProviderAndModel(config.defaultModel);

  return (
    typeof config.defaultProvider === "string" && config.defaultProvider.trim().length > 0
      ? config.defaultProvider
      : (parsed.provider ?? "anthropic")
  )
    .trim()
    .toLowerCase();
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

const toConfigResponse = (config: GhostboxConfig): GhostboxConfigResponse => {
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
    throw new ApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new ApiError(400, `Missing ${field}`);
  }

  return trimmed;
};

const normalizeNullableConfigValue = (value: unknown, field: string): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `Invalid ${field}`);
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
    throw new ApiError(400, `Invalid ${field}`);
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

const normalizeGhostImages = (value: unknown): GhostImage[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, "Invalid images");
  }

  return value.map((image) => {
    if (typeof image !== "object" || image === null) {
      throw new ApiError(400, "Invalid images");
    }

    const { mediaType, data } = image as {
      mediaType?: unknown;
      data?: unknown;
    };

    if (typeof mediaType !== "string" || typeof data !== "string") {
      throw new ApiError(400, "Invalid images");
    }

    return { mediaType, data };
  });
};

const normalizeStreamingBehavior = (value: unknown): GhostStreamingBehavior | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === "steer" || value === "followUp") {
    return value;
  }

  throw new ApiError(400, "Invalid streamingBehavior");
};

const normalizeMailTextField = (value: unknown, field: "from" | "to" | "subject" | "body"): string => {
  if (typeof value !== "string") {
    throw new ApiError(400, `Missing ${field}`);
  }

  if (field === "body") {
    if (!value.trim()) {
      throw new ApiError(400, "Missing body");
    }

    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, `Missing ${field}`);
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

  throw new ApiError(400, "Invalid priority");
};

const normalizeMailThreadId = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, "Invalid threadId");
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

const authenticateApiToken = async (token: string | null): Promise<ApiAuthContext | null> => {
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

const validateMailSize = (subject: string, body: string): void => {
  if (subject.length > MAIL_SUBJECT_MAX_LENGTH) {
    throw new ApiError(400, `Subject exceeds ${MAIL_SUBJECT_MAX_LENGTH} characters`);
  }

  if (body.length > MAIL_BODY_MAX_LENGTH) {
    throw new ApiError(400, `Body exceeds ${MAIL_BODY_MAX_LENGTH} characters`);
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
            throw new ApiError(400, "Invalid from");
          }

          const trimmed = requestedFrom.trim();
          if (!trimmed) {
            throw new ApiError(400, "Missing from");
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
    throw new ApiError(403, "User token can only send mail from user");
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

const getErrorStatus = (error: unknown): ApiStatusCode => {
  if (error instanceof ApiError) {
    return error.status;
  }

  const message = error instanceof Error ? error.message : "Internal server error";

  if (message.includes("not found")) {
    return 404;
  }

  if (
    message.includes("already exists") ||
    message.includes("is not running") ||
    message.includes("is not stopped") ||
    message.includes("must be stopped")
  ) {
    return 409;
  }

  if (
    message.includes("Invalid") ||
    message.includes("Missing") ||
    message.includes("Provider mismatch") ||
    message.includes("Unsupported provider") ||
    message.includes("Model is required")
  ) {
    return 400;
  }

  return 500;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return "Internal server error";
};

const parseJsonBody = async <T>(c: Context): Promise<T> => {
  try {
    const text = await c.req.text();
    if (!text || text.trim().length === 0) {
      log.error(
        { method: c.req.method, path: c.req.path, contentType: c.req.header("content-type") },
        "Empty request body"
      );
      throw new ApiError(400, "Empty request body");
    }
    try {
      return JSON.parse(text) as T;
    } catch (parseErr) {
      log.error(
        {
          method: c.req.method,
          path: c.req.path,
          bodyPreview: text.slice(0, 200),
          contentType: c.req.header("content-type")
        },
        "JSON parse failed"
      );
      throw new ApiError(400, `Invalid JSON body: ${(parseErr as Error).message}`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log.error({ method: c.req.method, path: c.req.path, err }, "Failed to read request body");
    throw new ApiError(400, "Could not read request body");
  }
};

const dispatchScheduledPrompt = async (schedule: GhostSchedule): Promise<void> => {
  const ghost = await getGhost(schedule.ghostName);

  if (ghost.status === "stopped") {
    await wakeGhost(schedule.ghostName);
  }

  void (async () => {
    try {
      for await (const _message of sendMessage(schedule.ghostName, schedule.prompt)) {
      }
    } catch (error) {
      log.error({ err: error, scheduleId: schedule.id, ghostName: schedule.ghostName }, "Scheduled prompt failed");
    }
  })();
};

const scheduleManager = new ScheduleManager(dispatchScheduledPrompt);

const handleRoute = async (c: Context, handler: () => Promise<Response>): Promise<Response> => {
  try {
    return await handler();
  } catch (error) {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error);

    log.error({ err: error, method: c.req.method, path: c.req.path, status }, "API request failed");

    return c.json({ error: message }, { status });
  }
};

app.use(
  "/api/*",
  cors({
    origin: async (origin) => {
      if (!origin) {
        return null;
      }

      const state = await loadState();
      const allowedOrigins = resolveAllowedCorsOrigins(state.config);
      return allowedOrigins.includes(origin) ? origin : null;
    }
  })
);

// Polling endpoints that don't need per-request logging
const QUIET_ROUTES = new Set(["/api/ghosts", "/api/config", "/api/auth"]);

app.use("/api/*", async (c, next) => {
  const startedAt = Date.now();

  await next();

  const isQuietPoll = c.req.method === "GET" && QUIET_ROUTES.has(c.req.path) && c.res.status === 200;
  if (!isQuietPoll) {
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - startedAt
      },
      "API request"
    );
  }
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  try {
    const token = extractBearerToken(c.req.header("authorization"));
    const auth = await authenticateApiToken(token);

    if (!auth) {
      return c.json({ error: "Unauthorized" }, { status: 401 });
    }

    c.set("apiAuth", auth);
    await next();
  } catch (error) {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error);

    log.error({ err: error, method: c.req.method, path: c.req.path, status }, "API auth failed");

    return c.json({ error: message }, { status });
  }
});

app.get("/api/ghosts", (c) =>
  handleRoute(c, async () => {
    return c.json(await listGhosts());
  })
);

app.get("/api/ghosts/:name", (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhost(c.req.param("name")));
  })
);

app.patch("/api/ghosts/:name", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<UpdateGhostBody>(c);

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError(400, "Invalid request body");
    }

    const unexpectedField = Object.keys(body).find((key) => !["model", "provider"].includes(key));
    if (unexpectedField) {
      throw new ApiError(400, `Invalid field "${unexpectedField}"`);
    }

    if (!("model" in body) && !("provider" in body)) {
      throw new ApiError(400, "At least one of model or provider is required.");
    }

    let requestedModel: string | undefined;
    let requestedProvider: string | undefined;

    if ("model" in body) {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        throw new ApiError(400, "Invalid model");
      }

      requestedModel = body.model.trim();
    }

    if ("provider" in body) {
      if (typeof body.provider !== "string" || body.provider.trim().length === 0) {
        throw new ApiError(400, "Invalid provider");
      }

      requestedProvider = body.provider.trim().toLowerCase();
    }

    const parsedModel = requestedModel ? parseProviderAndModel(requestedModel) : null;
    if (parsedModel?.provider && requestedProvider && parsedModel.provider !== requestedProvider) {
      throw new ApiError(
        400,
        `Provider mismatch: model uses "${parsedModel.provider}" but provider was "${requestedProvider}".`
      );
    }

    const update: { model?: string; provider?: string } = {};

    if (parsedModel) {
      update.model = parsedModel.model;
    }

    if (parsedModel?.provider) {
      update.provider = parsedModel.provider;
    } else if (requestedProvider) {
      update.provider = requestedProvider;
    }

    return c.json(await updateGhost(c.req.param("name"), update));
  })
);

app.post("/api/ghosts", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<SpawnBody>(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const requestedProvider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : undefined;

    if (!name) {
      throw new ApiError(400, "Missing name");
    }

    const config = (await getConfig()) as LegacyConfig;
    const modelInput = requestedModel || config.defaultModel;
    const parsedModel = parseProviderAndModel(modelInput);

    if (!parsedModel.model) {
      throw new ApiError(400, "Model is required.");
    }

    if (parsedModel.provider && requestedProvider && parsedModel.provider !== requestedProvider) {
      throw new ApiError(
        400,
        `Provider mismatch: model uses "${parsedModel.provider}" but provider was "${requestedProvider}".`
      );
    }

    const provider = parsedModel.provider ?? (requestedProvider || getDefaultProvider(config));
    await spawnGhost(name, provider, parsedModel.model, systemPrompt);

    return c.json(await getGhost(name), 201);
  })
);

app.post("/api/ghosts/:name/kill", (c) =>
  handleRoute(c, async () => {
    await killGhost(c.req.param("name"));
    return c.json({ status: "killed" });
  })
);

app.post("/api/ghosts/:name/wake", (c) =>
  handleRoute(c, async () => {
    await wakeGhost(c.req.param("name"));
    return c.json({ status: "running" });
  })
);

app.delete("/api/ghosts/:name", (c) =>
  handleRoute(c, async () => {
    await removeGhost(c.req.param("name"));
    return c.json({ status: "removed" });
  })
);

app.get("/api/ghosts/:name/health", (c) =>
  handleRoute(c, async () => {
    return c.json({ healthy: await getGhostHealth(c.req.param("name")) });
  })
);

app.get("/api/ghosts/:name/history", (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostHistory(c.req.param("name")));
  })
);

app.get("/api/ghosts/:name/sessions", (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostSessions(c.req.param("name")));
  })
);

app.get("/api/ghosts/:name/stats", (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostStats(c.req.param("name")));
  })
);

app.get("/api/ghosts/:name/schedules", (c) =>
  handleRoute(c, async () => {
    return c.json(await scheduleManager.list(c.req.param("name")));
  })
);

app.post("/api/ghosts/:name/schedules", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<ScheduleCreateBody>(c);
    return c.json(await scheduleManager.create(c.req.param("name"), body), 201);
  })
);

app.delete("/api/ghosts/:name/schedules/:id", (c) =>
  handleRoute(c, async () => {
    await scheduleManager.delete(c.req.param("name"), c.req.param("id"));
    return c.json({ status: "deleted" });
  })
);

app.post("/api/mail/send", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<MailSendBody>(c);
    const auth = c.var.apiAuth;
    const { from, authenticatedBy } = resolveAuthenticatedMailSender(body.from, auth);
    const to = normalizeMailTextField(body.to, "to");
    const subject = normalizeMailTextField(body.subject, "subject");
    const mailBody = normalizeMailTextField(body.body, "body");
    const priority = normalizeMailPriority(body.priority);
    const threadId = normalizeMailThreadId(body.threadId);

    validateMailSize(subject, mailBody);

    const retryAfter = checkMailSendRateLimit(auth.authenticatedBy);
    if (retryAfter !== null) {
      return c.json({ error: "Rate limit exceeded", retryAfter }, { status: 429 });
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

    return c.json({ status: "sent", id: message.id });
  })
);

app.get("/api/mail/:ghostName", (c) =>
  handleRoute(c, async () => {
    const unreadOnly = c.req.query("unread") === "true";
    const mailboxState = await loadMailboxState();
    const ghostName = c.req.param("ghostName");

    if (c.var.apiAuth.ghostName !== ghostName) {
      throw new ApiError(403, "Forbidden");
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

    return c.json({ messages });
  })
);

app.post("/api/mail/:id/read", (c) =>
  handleRoute(c, async () => {
    const mailboxState = await loadMailboxState();
    const message = mailboxState.messages.find((entry) => entry.id === c.req.param("id"));

    if (!message) {
      throw new ApiError(404, `Mail message "${c.req.param("id")}" not found.`);
    }

    if (!canAccessMailMessage(message, c.var.apiAuth.ghostName)) {
      throw new ApiError(403, "Forbidden");
    }

    message.readAt = new Date().toISOString();
    await saveMailboxState(mailboxState);

    return c.json({ status: "read" });
  })
);

app.delete("/api/mail/:id", (c) =>
  handleRoute(c, async () => {
    const mailboxState = await loadMailboxState();
    const message = mailboxState.messages.find((entry) => entry.id === c.req.param("id"));

    if (!message) {
      throw new ApiError(404, `Mail message "${c.req.param("id")}" not found.`);
    }

    if (!canAccessMailMessage(message, c.var.apiAuth.ghostName)) {
      throw new ApiError(403, "Forbidden");
    }

    const nextMessages = mailboxState.messages.filter((message) => message.id !== c.req.param("id"));

    await saveMailboxState({ messages: nextMessages });

    return c.json({ status: "deleted" });
  })
);

app.post("/api/ghosts/:name/message", async (c) => {
  try {
    const name = c.req.param("name");
    const body = await parseJsonBody<MessageBody>(c);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const modelValue = typeof body.model === "string" ? body.model.trim() : "";
    const model = modelValue || undefined;
    const images = normalizeGhostImages(body.images);
    const streamingBehavior = normalizeStreamingBehavior(body.streamingBehavior);
    const ghost = await getGhost(name);

    if (!prompt) {
      throw new ApiError(400, "Missing prompt");
    }

    if (ghost.status === "stopped") {
      await wakeGhost(name);
    }

    const messages = sendMessage(name, prompt, model, images, streamingBehavior);

    return streamSSE(
      c,
      async (stream) => {
        try {
          for await (const message of messages) {
            await stream.writeSSE({
              event: "message",
              data: JSON.stringify(message)
            });
          }

          await stream.writeSSE({ event: "done", data: "" });
        } catch (streamError) {
          log.error({ err: streamError, method: c.req.method, path: c.req.path }, "SSE stream failed");
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: getErrorMessage(streamError) })
          });
          await stream.writeSSE({ event: "done", data: "" });
        }
      },
      async (error) => {
        log.error({ err: error, method: c.req.method, path: c.req.path }, "SSE stream aborted");
      }
    );
  } catch (error) {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error);

    log.error({ err: error, method: c.req.method, path: c.req.path, status }, "API request failed");

    return c.json({ error: message }, { status });
  }
});

app.post("/api/ghosts/:name/steer", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<SteerBody>(c);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const images = normalizeGhostImages(body.images);

    if (!prompt) {
      throw new ApiError(400, "Missing prompt");
    }

    return c.json(await steerGhost(c.req.param("name"), prompt, images));
  })
);

app.get("/api/ghosts/:name/queue", (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostQueue(c.req.param("name")));
  })
);

app.post("/api/ghosts/:name/clear-queue", (c) =>
  handleRoute(c, async () => {
    return c.json(await clearGhostQueue(c.req.param("name")));
  })
);

app.get("/api/ghosts/:name/keys", (c) =>
  handleRoute(c, async () => {
    return c.json(await listApiKeys(c.req.param("name")));
  })
);

app.post("/api/ghosts/:name/keys", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<GenerateKeyBody>(c);
    const label = typeof body.label === "string" ? body.label.trim() : "";

    if (!label) {
      throw new ApiError(400, "Missing label");
    }

    return c.json(await generateApiKey(c.req.param("name"), label), 201);
  })
);

app.delete("/api/ghosts/:name/keys/:keyId", (c) =>
  handleRoute(c, async () => {
    await revokeApiKey(c.req.param("name"), c.req.param("keyId"));
    return c.json({ status: "revoked" });
  })
);

app.post("/api/ghosts/:name/save", (c) =>
  handleRoute(c, async () => {
    return c.json({ commitHash: await commitVault(c.req.param("name")) });
  })
);

app.get("/api/ghosts/:name/vault", (c) =>
  handleRoute(c, async () => {
    try {
      const { vaultPath, fullPath } = await resolveVaultItemPath(c.req.param("name"), c.req.query("path"), {
        allowRoot: true
      });
      const directoryStats = await stat(fullPath);

      if (!directoryStats.isDirectory()) {
        throw new ApiError(400, "Path must be a directory");
      }

      return c.json({ entries: await readVaultEntries(vaultPath, fullPath) });
    } catch (error) {
      return throwVaultFsError(error);
    }
  })
);

app.get("/api/ghosts/:name/vault/read", (c) =>
  handleRoute(c, async () => {
    try {
      const { fullPath, apiPath } = await resolveVaultItemPath(c.req.param("name"), c.req.query("path"));
      const fileStats = await stat(fullPath);

      if (!fileStats.isFile()) {
        throw new ApiError(400, "Path must be a file");
      }

      return c.json({
        path: apiPath,
        content: await readFile(fullPath, "utf8"),
        size: fileStats.size
      });
    } catch (error) {
      return throwVaultFsError(error);
    }
  })
);

app.put("/api/ghosts/:name/vault/write", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultWriteBody>(c);
    const inputPath = typeof body.path === "string" ? body.path : undefined;
    const content = typeof body.content === "string" ? body.content : null;

    if (content === null) {
      throw new ApiError(400, "Missing content");
    }

    const { fullPath, apiPath } = await resolveVaultItemPath(c.req.param("name"), inputPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    const fileStats = await stat(fullPath);

    return c.json({
      path: apiPath,
      size: fileStats.size
    });
  })
);

app.delete("/api/ghosts/:name/vault/delete", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultDeleteBody>(c);
    const inputPath = typeof body.path === "string" ? body.path : undefined;

    try {
      const { fullPath, apiPath } = await resolveVaultItemPath(c.req.param("name"), inputPath);
      const fileStats = await stat(fullPath);

      if (!fileStats.isFile()) {
        throw new ApiError(400, "Path must be a file");
      }

      const { exitCode, stderr: trashStdErr } = await new Promise<{ exitCode: number; stderr: string }>(
        (resolve, reject) => {
          const proc = nodeSpawn("trash", [fullPath], { stdio: ["ignore", "pipe", "pipe"] });
          let stderr = "";
          proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          proc.on("error", reject);
          proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
        }
      );

      if (exitCode !== 0) {
        throw new Error(`Trash command failed: ${trashStdErr.trim()}`);
      }

      return c.json({ path: apiPath, status: "deleted" as const });
    } catch (error) {
      return throwVaultFsError(error);
    }
  })
);

app.post("/api/ghosts/:name/merge", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<MergeBody>(c);
    const target = typeof body.target === "string" ? body.target.trim() : "";

    if (!target) {
      throw new ApiError(400, "Missing target");
    }

    return c.json({ result: await mergeGhosts(c.req.param("name"), target) });
  })
);

app.get("/api/auth", (c) =>
  handleRoute(c, async () => {
    return c.json(await getAuthStatus());
  })
);

app.get("/api/config", (c) =>
  handleRoute(c, async () => {
    return c.json(toConfigResponse(await getConfig()));
  })
);

app.put("/api/config", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<ConfigUpdateBody>(c);
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

    return c.json(toConfigResponse(nextConfig));
  })
);

app.post("/api/ghosts/:name/reload", (c) =>
  handleRoute(c, async () => {
    await reloadGhost(c.req.param("name"));
    return c.json({ status: "reloaded" });
  })
);

app.post("/api/ghosts/:name/compact", (c) =>
  handleRoute(c, async () => {
    await compactGhost(c.req.param("name"));
    return c.json({ status: "compacted" });
  })
);

app.post("/api/ghosts/:name/abort", (c) =>
  handleRoute(c, async () => {
    await abortGhost(c.req.param("name"));
    return c.json({ status: "aborted" });
  })
);

app.post("/api/ghosts/:name/new", (c) =>
  handleRoute(c, async () => {
    return c.json(await newGhostSession(c.req.param("name")));
  })
);

app.post("/api/ghosts/:name/sessions/switch", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<SessionSwitchBody>(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!sessionId) {
      throw new ApiError(400, "Missing sessionId");
    }

    return c.json(await switchGhostSession(c.req.param("name"), sessionId));
  })
);

app.post("/api/ghosts/:name/sessions/rename", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<{ sessionId?: string; name?: string }>(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!sessionId) {
      throw new ApiError(400, "Missing sessionId");
    }

    return c.json(await renameGhostSession(c.req.param("name"), sessionId, name));
  })
);

app.delete("/api/ghosts/:name/sessions/:sessionId", (c) =>
  handleRoute(c, async () => {
    return c.json(await deleteGhostSession(c.req.param("name"), c.req.param("sessionId")));
  })
);

app.notFound((c) => c.json({ error: "Not found" }, { status: 404 }));

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json"
};

const getMimeType = (filePath: string): string => {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return mimeTypes[ext] ?? "application/octet-stream";
};

const tryReadFile = async (filePath: string): Promise<Buffer | null> => {
  try {
    const content = await readFile(filePath);
    return content;
  } catch {
    return null;
  }
};

const __apiFilename = fileURLToPath(import.meta.url);
const __apiDirname = dirname(__apiFilename);

if (import.meta.main || process.argv[1] === __apiFilename) {
  const webDir = resolve(__apiDirname, "..", "web");
  await ensureApiAdminToken();

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return app.fetch(req);
    }

    const filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const content = await tryReadFile(resolve(webDir, filePath));
    if (content) {
      return new Response(new Uint8Array(content), { headers: { "Content-Type": getMimeType(filePath) } });
    }

    const indexContent = await tryReadFile(resolve(webDir, "index.html"));
    if (indexContent) {
      return new Response(new Uint8Array(indexContent), { headers: { "Content-Type": "text/html" } });
    }

    return app.fetch(req);
  };

  // Try preferred port, fall back up to 10 ports higher
  let boundPort = port;
  let server: ReturnType<typeof createServer> | null = null;

  const tryListen = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer(async (req, res) => {
        const url = `http://localhost:${p}${req.url ?? "/"}`;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const reqBody = hasBody
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => resolve(Buffer.concat(chunks)));
            })
          : undefined;
        const response = await handler(
          new Request(url, {
            method: req.method,
            headers,
            body: reqBody ? new Uint8Array(reqBody) : undefined
          })
        );
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } finally {
            reader.releaseLock();
          }
          res.end();
        } else {
          res.end();
        }
      });
      // Disable request timeout so SSE streams for long-running agent
      // tool calls (bash polling, file reads) don't get killed at 5 min.
      s.requestTimeout = 0;
      s.headersTimeout = 0;
      s.once("error", () => resolve(false));
      s.listen(p, () => {
        server = s;
        resolve(true);
      });
    });

  for (let attempt = 0; attempt < 10; attempt++) {
    if (await tryListen(port + attempt)) {
      boundPort = port + attempt;
      break;
    }
  }

  process.env.GHOSTBOX_API_PORT = String(boundPort);

  if (server) {
    log.info({ port: boundPort }, "Ghostbox server listening");
  } else {
    log.error({ port }, "Failed to bind any port");
    process.exit(1);
  }

  // Reconcile ghost states - restart containers that should be running
  reconcileGhostStates()
    .then(({ started, marked }) => {
      if (marked.length > 0) {
        log.info({ started, marked }, "Ghost state reconciliation complete");
      }
      scheduleManager.start();
    })
    .catch((err) => {
      log.error({ err }, "Ghost state reconciliation failed");
      scheduleManager.start();
    });

  // Graceful shutdown - stop all running ghost containers
  const shutdown = async () => {
    log.info("Shutting down - stopping ghost containers...");
    scheduleManager.stop();
    try {
      const ghosts = await listGhosts();
      for (const [name, ghost] of Object.entries(ghosts)) {
        if (ghost.status !== "running") continue;
        try {
          await killGhost(name);
          log.info({ name }, "Stopped ghost");
        } catch {
          log.error({ name }, "Failed to stop ghost");
        }
      }
    } catch {
      // State might not be readable
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { app };
export default app;
