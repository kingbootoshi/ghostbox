import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLogger } from "./logger";
import { getGhost, sendMessage, wakeGhost } from "./orchestrator";
import type { GhostSchedule } from "./types";
import { getHomeDirectory, isNodeError } from "./utils";

type ApiStatusCode = 400 | 404;
type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

type ParsedCronField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = Record<CronFieldName, ParsedCronField>;
type ScheduleDispatcher = (schedule: GhostSchedule) => Promise<void>;

const log = createLogger("api");

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

const createApiError = (status: ApiStatusCode, message: string): Error & { status: ApiStatusCode } => {
  const error = new Error(message) as Error & { status: ApiStatusCode };
  error.name = "ApiError";
  error.status = status;
  return error;
};

const getSchedulePath = (): string => resolve(getHomeDirectory(), ".ghostbox", "schedules.json");

const normalizeScheduleTimezone = (value: unknown): string => {
  if (value === undefined) {
    return SYSTEM_TIMEZONE;
  }

  if (typeof value !== "string") {
    throw createApiError(400, "Invalid timezone");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return SYSTEM_TIMEZONE;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    throw createApiError(400, "Invalid timezone");
  }
};

const normalizeSchedulePrompt = (value: unknown): string => {
  if (typeof value !== "string") {
    throw createApiError(400, "Missing prompt");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw createApiError(400, "Missing prompt");
  }

  return trimmed;
};

const normalizeScheduleCron = (value: unknown): string => {
  if (typeof value !== "string") {
    throw createApiError(400, "Missing cron");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw createApiError(400, "Missing cron");
  }

  return trimmed;
};

const normalizeScheduleOnce = (value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw createApiError(400, "Invalid once");
  }

  return value;
};

const parseCronNumber = (token: string, min: number, max: number, fieldName: CronFieldName): number => {
  const value = Number(token);
  if (!Number.isInteger(value)) {
    throw createApiError(400, `Invalid cron field: ${fieldName}`);
  }

  if (fieldName === "dayOfWeek" && value === 7) {
    return 0;
  }

  if (value < min || value > max) {
    throw createApiError(400, `Invalid cron field: ${fieldName}`);
  }

  return value;
};

const expandCronSegment = (token: string, min: number, max: number, fieldName: CronFieldName): number[] => {
  const [rangePart, stepPart] = token.split("/");
  const step = stepPart === undefined ? 1 : Number(stepPart);

  if (!Number.isInteger(step) || step <= 0) {
    throw createApiError(400, `Invalid cron field: ${fieldName}`);
  }

  let start = min;
  let end = max;

  if (rangePart !== "*") {
    if (rangePart.includes("-")) {
      const [startToken, endToken] = rangePart.split("-");
      if (!startToken || !endToken) {
        throw createApiError(400, `Invalid cron field: ${fieldName}`);
      }

      start = parseCronNumber(startToken, min, max, fieldName);
      end = parseCronNumber(endToken, min, max, fieldName);

      if (start > end) {
        throw createApiError(400, `Invalid cron field: ${fieldName}`);
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
    throw createApiError(400, `Invalid cron field: ${fieldName}`);
  }

  const wildcard = field === "*";
  const values = new Set<number>();

  for (const segment of field.split(",")) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) {
      throw createApiError(400, `Invalid cron field: ${fieldName}`);
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
    throw createApiError(400, "Invalid cron");
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
    throw createApiError(400, "Invalid timezone");
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

  throw createApiError(400, "Cron does not produce a future run time");
};

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
      throw createApiError(404, `Schedule "${id}" not found.`);
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

export const scheduleManager = new ScheduleManager(dispatchScheduledPrompt);
