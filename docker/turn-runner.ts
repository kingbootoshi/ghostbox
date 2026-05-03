import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { GhostMessage } from "../src/types";
import type { Sink } from "./sinks";

type JsonRecord = Record<string, unknown>;

export type TurnOutcome = "result" | "idle_timeout" | "wallclock_timeout" | "subprocess_error" | "host_aborted";

export type ClaudeSpawnConfig = {
  args: string[];
  snapshotPrompt: string;
  snapshotPersisted: boolean;
};

export type RunClaudeTurnResult = {
  outcome: TurnOutcome;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  lastStdoutAt: string | null;
  bytesStreamed: number;
};

export type RunClaudeTurnOptions<TState> = {
  turnId: string;
  idleTimeoutMs: number;
  wallTimeoutMs: number;
  buildClaudeArgs: (messages: UserTurn[]) => Promise<ClaudeSpawnConfig>;
  createUserTurn: (text: string, images: UserTurn["images"]) => string;
  createStreamState: () => TState;
  handleClaudeStreamLine: (sink: Sink, line: JsonRecord, state: TState) => void;
  getEventName: (line: JsonRecord) => string;
  getResultText: (state: TState) => string;
  getSessionId: () => string;
  claudeBinaryPath?: string;
  claudeWorkingDirectory?: string;
  abortSignal: AbortSignal;
  onChild: (child: ChildProcessWithoutNullStreams) => void;
  onChildClosed: () => void;
  onResult: () => void;
  log: (level: "INFO" | "ERROR", message: string, context?: JsonRecord) => void;
};

export type UserTurn = {
  text: string;
  images: Array<{ mediaType: string; data: string }>;
};

type KillReason = "idle_timeout" | "wallclock_timeout" | "host_aborted";

const HEARTBEAT_INTERVAL_MS = 30_000;
const KILL_GRACE_MS = 5_000;

const formatTimeout = (ms: number): string => {
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }

  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }

  return `${ms}ms`;
};

const timeoutMessage = (reason: KillReason, idleTimeoutMs: number, wallTimeoutMs: number): string => {
  if (reason === "idle_timeout") {
    return `Turn killed: idle ${formatTimeout(idleTimeoutMs)}`;
  }

  if (reason === "wallclock_timeout") {
    return `Turn killed: wall-clock ${formatTimeout(wallTimeoutMs)}`;
  }

  return "Turn aborted.";
};

export const runClaudeTurn = async <TState>(
  messages: UserTurn[],
  sink: Sink,
  options: RunClaudeTurnOptions<TState>
): Promise<RunClaudeTurnResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { args } = await options.buildClaudeArgs(messages);
  const child = nodeSpawn(options.claudeBinaryPath ?? process.env.GHOSTBOX_CLAUDE_BINARY_PATH ?? "claude", args, {
    cwd: options.claudeWorkingDirectory ?? "/vault",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || "/vault/.claude"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  options.onChild(child);

  const state = options.createStreamState();
  const stdoutDecoder = new StringDecoder("utf8");
  let buffer = "";
  let receivedResult = false;
  let killReason: KillReason | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastStdoutAtMs: number | null = null;
  let bytesStreamed = 0;
  let terminalEmitted = false;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (wallTimer) clearTimeout(wallTimer);
    if (killTimer) clearTimeout(killTimer);
    if (heartbeat) clearInterval(heartbeat);
  };

  const armKillTimer = (reason: string): void => {
    if (killTimer) {
      clearTimeout(killTimer);
    }
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
    options.log("ERROR", "Claude turn kill escalation armed", {
      turn_id: options.turnId,
      reason
    });
  };

  const requestKill = (reason: KillReason): void => {
    if (killReason) {
      return;
    }

    killReason = reason;
    options.log("ERROR", "Killing Claude turn", {
      turn_id: options.turnId,
      reason,
      childPid: child.pid ?? 0
    });

    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }

    armKillTimer(reason);
  };

  const terminateAfterResult = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (wallTimer) {
      clearTimeout(wallTimer);
      wallTimer = null;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }

    armKillTimer("result");
  };

  const resetIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => requestKill("idle_timeout"), options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const emitTerminalLine = (line: GhostMessage): void => {
    if (!terminalEmitted) {
      sink.sendLine(line);
      terminalEmitted = true;
    }
  };

  const processLine = (rawLine: string, trailing: boolean): void => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as JsonRecord;
      const eventName = options.getEventName(parsed);
      if (eventName === "result" && killReason) {
        options.log("ERROR", "Claude result/timeout race resolved", {
          turn_id: options.turnId,
          winner: "timeout_marker",
          suppressed: "result",
          reason: killReason
        });
        return;
      }
      options.handleClaudeStreamLine(sink, parsed, state);
      if (eventName === "result" && !receivedResult) {
        receivedResult = true;
        options.onResult();
        terminateAfterResult();
      }
    } catch (error) {
      options.log("ERROR", trailing ? "Failed to parse trailing Claude stream line" : "Failed to parse Claude stream line", {
        turn_id: options.turnId,
        error: error instanceof Error ? error.message : String(error),
        line: trimmed
      });
    }
  };

  resetIdleTimer();
  wallTimer = setTimeout(() => requestKill("wallclock_timeout"), options.wallTimeoutMs);
  wallTimer.unref?.();
  heartbeat = setInterval(() => sink.sendLine({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  options.abortSignal.addEventListener("abort", () => requestKill("host_aborted"), { once: true });

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    bytesStreamed += chunk.byteLength;
    lastStdoutAtMs = Date.now();
    resetIdleTimer();
    buffer += stdoutDecoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      processLine(rawLine, false);
    }
  });

  for (const message of messages) {
    child.stdin.write(options.createUserTurn(message.text, message.images));
  }
  child.stdin.end();

  const closeResult = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.on("error", (error) => {
      options.log("ERROR", "Claude process error", {
        turn_id: options.turnId,
        error: error.message
      });
      resolve({ code: 1, error });
    });

    child.on("close", (code) => {
      resolve({ code, error: null });
    });
  });

  clearTimers();
  options.onChildClosed();
  buffer += stdoutDecoder.end();
  processLine(buffer, true);

  if (closeResult.error) {
    throw closeResult.error;
  }

  let outcome: TurnOutcome = "result";

  if (killReason === "idle_timeout" || killReason === "wallclock_timeout") {
    outcome = killReason;
    emitTerminalLine({
      type: "result",
      text: timeoutMessage(killReason, options.idleTimeoutMs, options.wallTimeoutMs),
      sessionId: options.getSessionId()
    });
  } else if (killReason === "host_aborted" && !receivedResult) {
    outcome = "host_aborted";
    emitTerminalLine({
      type: "aborted",
      reason: timeoutMessage(killReason, options.idleTimeoutMs, options.wallTimeoutMs),
      sessionId: options.getSessionId()
    });
  } else if ((closeResult.code ?? 0) !== 0 && !receivedResult) {
    outcome = "subprocess_error";
    const message = closeResult.error?.message ?? `Claude subprocess exited with code ${closeResult.code ?? 1}.`;
    options.log("ERROR", message, {
      turn_id: options.turnId,
      sessionId: options.getSessionId()
    });
    emitTerminalLine({
      type: "result",
      text: message,
      sessionId: options.getSessionId()
    });
  } else if (!receivedResult) {
    emitTerminalLine({
      type: "result",
      text: options.getResultText(state),
      sessionId: options.getSessionId()
    });
  }

  sink.end();

  const endedAtMs = Date.now();
  return {
    outcome,
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    lastStdoutAt: lastStdoutAtMs ? new Date(lastStdoutAtMs).toISOString() : null,
    bytesStreamed
  };
};
