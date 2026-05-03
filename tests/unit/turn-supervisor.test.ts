import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "../../docker/sinks";
import { type RunClaudeTurnResult, runClaudeTurn, type UserTurn } from "../../docker/turn-runner";
import { TurnSupervisor, type TurnWorkItem } from "../../docker/turn-supervisor";
import type { GhostMessage } from "../../src/types";

type JsonRecord = Record<string, unknown>;

class CollectSink implements Sink {
  readonly lines: GhostMessage[] = [];
  ended = false;

  sendLine(line: GhostMessage): void {
    if (!this.ended) {
      this.lines.push(line);
    }
  }

  end(): void {
    this.ended = true;
  }
}

const logs: JsonRecord[] = [];
let tempDir = "";

const removeTempDir = async (path: string): Promise<void> => {
  if (!path) {
    return;
  }
  const trash = Bun.spawn(["which", "trash"], { stdout: "pipe", stderr: "ignore" });
  const hasTrash = (await trash.exited) === 0;
  const command = hasTrash ? ["trash", path] : ["rm", "-rf", path];
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to remove ${path}: ${stderr.trim()}`);
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await Bun.sleep(20);
  }
};

const createFakeClaude = async (): Promise<string> => {
  const path = join(tempDir, "fake-claude.js");
  await writeFile(
    path,
    `#!/usr/bin/env bun
process.on("SIGTERM", () => process.exit(143));
const input = await new Response(Bun.stdin.stream()).text();
if (input.includes("idle")) {
  console.log(JSON.stringify({ type: "assistant", text: "partial" }));
  setInterval(() => {}, 1000);
} else if (input.includes("wall")) {
  setInterval(() => console.log(JSON.stringify({ type: "assistant", text: "tick" })), 50);
} else if (input.includes("slow")) {
  await Bun.sleep(500);
  console.log(JSON.stringify({ type: "assistant", text: "slow" }));
  console.log(JSON.stringify({ type: "result", text: "slow", sessionId: "session-1" }));
} else {
  console.log(JSON.stringify({ type: "assistant", text: "done" }));
  console.log(JSON.stringify({ type: "result", text: "done", sessionId: "session-1" }));
}
`,
    "utf8"
  );
  await chmod(path, 0o755);
  return path;
};

const textOf = (line: GhostMessage): string => (line.type === "assistant" || line.type === "result" ? line.text : "");

const createSupervisor = (
  binaryForItem: (item: TurnWorkItem) => string,
  eventSinks: CollectSink[] = []
): TurnSupervisor => {
  const processed: string[] = [];
  const supervisor = new TurnSupervisor({
    agentName: "test-ghost",
    makeEventSink: () => {
      const sink = new CollectSink();
      eventSinks.push(sink);
      return sink;
    },
    createUserTurn: (text) => text,
    getSessionId: () => "session-1",
    publishCompletion: () => {},
    log: (_level, message, context) => logs.push({ message, ...(context ?? {}) }),
    runTurn: async (item, sink, context): Promise<RunClaudeTurnResult> => {
      processed.push(item.userTurn.text);
      return runClaudeTurn([item.userTurn], sink, {
        turnId: context.turnId,
        idleTimeoutMs: Number(process.env.GHOSTBOX_TURN_IDLE_TIMEOUT_MS ?? 5_000),
        wallTimeoutMs: Number(process.env.GHOSTBOX_TURN_WALL_TIMEOUT_MS ?? 5_000),
        buildClaudeArgs: async () => ({ args: [], snapshotPrompt: "", snapshotPersisted: true }),
        createUserTurn: (text) => text,
        createStreamState: () => ({ fallback: "" }),
        handleClaudeStreamLine: (lineSink, line) => {
          const eventType = typeof line.type === "string" ? line.type : "";
          if (eventType === "assistant" && typeof line.text === "string") {
            lineSink.sendLine({ type: "assistant", text: line.text });
          }
          if (eventType === "result") {
            lineSink.sendLine({
              type: "result",
              text: typeof line.text === "string" ? line.text : "",
              sessionId: "session-1"
            });
          }
        },
        getEventName: (line) => (typeof line.type === "string" ? line.type : ""),
        getResultText: () => "",
        getSessionId: () => "session-1",
        claudeBinaryPath: binaryForItem(item),
        claudeWorkingDirectory: tempDir,
        abortSignal: context.abortSignal,
        onChild: context.setChild,
        onChildClosed: context.clearChild,
        onResult: () => {},
        log: (_level, message, context) => logs.push({ message, ...(context ?? {}) })
      });
    }
  });
  Object.defineProperty(supervisor, "processed", { value: processed });
  return supervisor;
};

const item = (
  text: string,
  sink = new CollectSink(),
  originator: TurnWorkItem["originator"] = "user"
): TurnWorkItem => ({
  userTurn: { text, images: [] satisfies UserTurn["images"] },
  deliverTo: sink,
  originator
});

describe("TurnSupervisor", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ghostbox-turn-supervisor-"));
    logs.length = 0;
  });

  afterEach(async () => {
    delete process.env.GHOSTBOX_TURN_IDLE_TIMEOUT_MS;
    delete process.env.GHOSTBOX_TURN_WALL_TIMEOUT_MS;
    await removeTempDir(tempDir);
    tempDir = "";
  });

  test("idle timeout emits a synthetic result and drains the next item", async () => {
    process.env.GHOSTBOX_TURN_IDLE_TIMEOUT_MS = "200";
    const binary = await createFakeClaude();
    const firstSink = new CollectSink();
    const eventSinks: CollectSink[] = [];
    const supervisor = createSupervisor(() => binary, eventSinks);

    await supervisor.enqueue(item("idle", firstSink));
    await supervisor.enqueue(item("fast"));

    await waitFor(() => eventSinks.some((sink) => sink.ended));
    expect(firstSink.lines.some((line) => line.type === "result" && line.text.includes("Turn killed: idle"))).toBe(
      true
    );
    expect(eventSinks.flatMap((sink) => sink.lines.map(textOf)).filter(Boolean)).toContain("done");
    expect(supervisor.currentTurn()).toBeNull();
  });

  test("auto-drains queued user turns in order", async () => {
    const binary = await createFakeClaude();
    const eventSinks: CollectSink[] = [];
    const supervisor = createSupervisor(() => binary, eventSinks);

    await supervisor.enqueue(item("one"));
    await supervisor.enqueue(item("two"));
    await supervisor.enqueue(item("three"));

    const processed = (supervisor as unknown as { processed: string[] }).processed;
    await waitFor(() => processed.length === 3);
    expect(processed).toEqual(["one", "two", "three"]);
  });

  test("runTurn rejection clears current and lets the next enqueue run", async () => {
    const binary = await createFakeClaude();
    const badSink = new CollectSink();
    const goodSink = new CollectSink();
    const supervisor = createSupervisor((workItem) =>
      workItem.userTurn.text === "bad" ? join(tempDir, "missing") : binary
    );

    await supervisor.enqueue(item("bad", badSink));
    await waitFor(() => badSink.ended);
    await supervisor.enqueue(item("good", goodSink));
    await waitFor(() => goodSink.ended);

    expect(badSink.lines).toContainEqual({ type: "aborted", reason: "runner_error", sessionId: "session-1" });
    expect(goodSink.lines.map(textOf).filter(Boolean)).toContain("done");
    expect(supervisor.currentTurn()).toBeNull();
  });

  test("wall-clock timeout reports wallclock outcome", async () => {
    process.env.GHOSTBOX_TURN_IDLE_TIMEOUT_MS = "1000";
    process.env.GHOSTBOX_TURN_WALL_TIMEOUT_MS = "300";
    const binary = await createFakeClaude();
    const sink = new CollectSink();
    const supervisor = createSupervisor(() => binary);

    await supervisor.enqueue(item("wall", sink));

    await waitFor(() => sink.ended);
    expect(sink.lines.some((line) => line.type === "result" && line.text.includes("Turn killed: wall-clock"))).toBe(
      true
    );
    expect(logs.some((entry) => entry.outcome === "wallclock_timeout")).toBe(true);
  });

  test("rejects scheduled turns while busy without running them later", async () => {
    const binary = await createFakeClaude();
    const sink = new CollectSink();
    const supervisor = createSupervisor(() => binary);

    await supervisor.enqueue(item("slow", sink));
    const rejected = await supervisor.enqueue(item("scheduled", new CollectSink(), "schedule"));

    await waitFor(() => sink.ended);
    expect(rejected).toEqual({ status: "rejected", reason: "busy" });
    const processed = (supervisor as unknown as { processed: string[] }).processed;
    expect(processed).toEqual(["slow"]);
  });
});
