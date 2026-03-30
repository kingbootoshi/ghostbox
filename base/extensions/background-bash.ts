import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const hostApiPort = process.env.GHOSTBOX_API_PORT || "8008";
const ghostName = process.env.GHOSTBOX_GHOST_NAME || "";
const ghostApiKey = process.env.GHOST_API_KEY || "";
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_COMPLETED_TASKS = 25;
const WATCH_INTERVAL_MS = 1000;
const OUTPUT_PREVIEW_CHARS = 12000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
};

type CapturedStream = {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
};

type TaskCompletion = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endTime: string;
};

type RunningTask = {
  process: ChildProcess;
  label: string;
  startTime: string;
  stdout: CapturedStream;
  stderr: CapturedStream;
  completion: TaskCompletion | null;
  notifyAttempts: number;
  notifyPending: boolean;
  lastNotifyError: string | null;
};

type CompletedTask = {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  notifiedAt: string;
};

const runningTasks = new Map<string, RunningTask>();
const completedTasks = new Map<string, CompletedTask>();
let watcherHandle: NodeJS.Timeout | null = null;

const result = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  details: {},
});

const createCapturedStream = (): CapturedStream => ({
  chunks: [],
  size: 0,
  truncated: false,
});

const appendChunk = (stream: CapturedStream, chunk: Buffer): void => {
  if (stream.size >= MAX_CAPTURE_BYTES) {
    stream.truncated = true;
    return;
  }

  const remaining = MAX_CAPTURE_BYTES - stream.size;
  const nextChunk = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  stream.chunks.push(nextChunk);
  stream.size += nextChunk.length;

  if (nextChunk.length < chunk.length) {
    stream.truncated = true;
  }
};

const streamToText = (stream: CapturedStream): string => {
  const text = Buffer.concat(stream.chunks).toString("utf8").trim();
  if (!stream.truncated) {
    return text;
  }

  const suffix = "\n[output truncated]";
  if (!text) {
    return "[output truncated]";
  }

  return `${text}${suffix}`;
};

const summarizeText = (text: string): string => {
  if (text.length <= OUTPUT_PREVIEW_CHARS) {
    return text;
  }

  return `${text.slice(0, OUTPUT_PREVIEW_CHARS)}\n[message truncated]`;
};

const ensureGhostContext = (): void => {
  if (!ghostName) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }
};

const buildSteerUrl = (): string => {
  ensureGhostContext();
  return `http://host.docker.internal:${hostApiPort}/api/ghosts/${encodeURIComponent(ghostName)}/steer`;
};

const buildCompletionPrompt = (id: string, task: RunningTask): string => {
  const completion = task.completion;
  const stdout = streamToText(task.stdout);
  const stderr = streamToText(task.stderr);
  const lines = [`[Background task ${id} completed]`, `Label: ${task.label}`];

  if (completion && completion.exitCode !== null) {
    lines.push(`Exit code: ${completion.exitCode}`);
  }

  if (completion?.signal) {
    lines.push(`Signal: ${completion.signal}`);
  }

  lines.push(`Started: ${task.startTime}`);
  lines.push(`Finished: ${completion?.endTime ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("Output:");
  lines.push(stdout || "(no stdout)");

  if (stderr) {
    lines.push("");
    lines.push("Error output:");
    lines.push(stderr);
  }

  return summarizeText(lines.join("\n"));
};

const notifyCompletion = async (id: string, task: RunningTask): Promise<void> => {
  const response = await fetch(buildSteerUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ghostApiKey ? { Authorization: `Bearer ${ghostApiKey}` } : {}),
    },
    body: JSON.stringify({
      prompt: buildCompletionPrompt(id, task),
    }),
  });

  if (!response.ok) {
    let message = `Background task callback failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error;
      }
    } catch {
      // Ignore JSON parsing issues and keep the default message.
    }

    throw new Error(message);
  }
};

const trimCompletedTasks = (): void => {
  while (completedTasks.size > MAX_COMPLETED_TASKS) {
    const oldestId = completedTasks.keys().next().value;
    if (!oldestId) {
      return;
    }
    completedTasks.delete(oldestId);
  }
};

const maybeStopWatcher = (): void => {
  if (watcherHandle && runningTasks.size === 0) {
    clearInterval(watcherHandle);
    watcherHandle = null;
  }
};

const pollTasks = (): void => {
  for (const [id, task] of runningTasks.entries()) {
    if (!task.completion || task.notifyPending) {
      continue;
    }

    task.notifyPending = true;
    task.notifyAttempts += 1;

    void notifyCompletion(id, task)
      .then(() => {
        completedTasks.set(id, {
          id,
          label: task.label,
          startTime: task.startTime,
          endTime: task.completion?.endTime ?? new Date().toISOString(),
          exitCode: task.completion?.exitCode ?? null,
          signal: task.completion?.signal ?? null,
          notifiedAt: new Date().toISOString(),
        });
        trimCompletedTasks();
        runningTasks.delete(id);
        maybeStopWatcher();
      })
      .catch((error: unknown) => {
        task.lastNotifyError = error instanceof Error ? error.message : "Unknown callback error.";
      })
      .finally(() => {
        task.notifyPending = false;
      });
  }
};

const ensureWatcher = (): void => {
  if (watcherHandle) {
    return;
  }

  watcherHandle = setInterval(pollTasks, WATCH_INTERVAL_MS);
  watcherHandle.unref();
};

const formatRunningTask = (id: string, task: RunningTask): string => {
  const base = [`- ${id}`, `label: ${task.label}`, `started: ${task.startTime}`];

  if (!task.completion) {
    base.push(`status: running`);
    if (typeof task.process.pid === "number") {
      base.push(`pid: ${task.process.pid}`);
    }
    return base.join(" | ");
  }

  base.push("status: completed - callback pending");
  if (task.completion.exitCode !== null) {
    base.push(`exit: ${task.completion.exitCode}`);
  }
  if (task.completion.signal) {
    base.push(`signal: ${task.completion.signal}`);
  }
  base.push(`finished: ${task.completion.endTime}`);
  base.push(`notify attempts: ${task.notifyAttempts}`);
  if (task.lastNotifyError) {
    base.push(`last callback error: ${task.lastNotifyError}`);
  }
  return base.join(" | ");
};

const formatCompletedTask = (task: CompletedTask): string => {
  const parts = [
    `- ${task.id}`,
    `label: ${task.label}`,
    `started: ${task.startTime}`,
    `finished: ${task.endTime}`,
    `notified: ${task.notifiedAt}`,
  ];

  if (task.exitCode !== null) {
    parts.push(`exit: ${task.exitCode}`);
  }
  if (task.signal) {
    parts.push(`signal: ${task.signal}`);
  }

  return parts.join(" | ");
};

const buildStatusText = (): string => {
  if (runningTasks.size === 0 && completedTasks.size === 0) {
    return "No running tasks.";
  }

  const lines: string[] = [];

  lines.push(`Running tasks: ${runningTasks.size}`);
  for (const [id, task] of runningTasks.entries()) {
    lines.push(formatRunningTask(id, task));
  }

  lines.push("");
  lines.push(`Completed tasks: ${completedTasks.size}`);
  const completedList = Array.from(completedTasks.values()).reverse();
  for (const task of completedList) {
    lines.push(formatCompletedTask(task));
  }

  return lines.join("\n");
};

const waitForSpawn = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleSpawn = (): void => {
      child.off("error", handleError);
      resolve();
    };

    const handleError = (error: Error): void => {
      child.off("spawn", handleSpawn);
      reject(error);
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "background_bash",
    label: "Background Bash",
    description:
      "Start a bash command in the background without blocking the conversation. Use for polling loops, watchers, long downloads, dev servers, and other commands that should report back later.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run in the background." }),
      label: Type.Optional(
        Type.String({ description: "Optional short label to make the task easy to recognize later." }),
      ),
    }),
    async execute(_toolCallId: string, params: { command: string; label?: string }) {
      ensureGhostContext();

      const command = params.command.trim();
      if (!command) {
        throw new Error("command is required");
      }

      const id = `bg-${randomUUID()}`;
      const label = params.label?.trim() || command;
      const child = spawn("bash", ["-lc", command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        cwd: process.cwd(),
      });

      const task: RunningTask = {
        process: child,
        label,
        startTime: new Date().toISOString(),
        stdout: createCapturedStream(),
        stderr: createCapturedStream(),
        completion: null,
        notifyAttempts: 0,
        notifyPending: false,
        lastNotifyError: null,
      };

      child.stdout?.on("data", (chunk: Buffer) => appendChunk(task.stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendChunk(task.stderr, chunk));
      child.on("close", (exitCode, signal) => {
        task.completion = {
          exitCode,
          signal,
          endTime: new Date().toISOString(),
        };
      });

      runningTasks.set(id, task);

      try {
        await waitForSpawn(child);
      } catch (error) {
        runningTasks.delete(id);
        maybeStopWatcher();
        throw error;
      }

      child.unref();
      ensureWatcher();

      return result(`Background task started. ID: ${id}. Label: ${label}`);
    },
  });

  pi.registerTool({
    name: "background_status",
    label: "Background Status",
    description: "List running background tasks and recently completed ones.",
    parameters: Type.Object({}),
    async execute() {
      return result(buildStatusText());
    },
  });

  (globalThis as any).__ghostbox_kill_bg_task = (taskId: string): { killed: boolean; taskId: string } => {
    const task = runningTasks.get(taskId);
    if (!task) return { killed: false, taskId };
    task.process.kill("SIGTERM");
    runningTasks.delete(taskId);
    maybeStopWatcher();
    return { killed: true, taskId };
  };
}
