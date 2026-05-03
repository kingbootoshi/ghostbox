import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { GhostQueueClearResponse, GhostQueueState } from "../src/types";
import type { Sink } from "./sinks";
import type { RunClaudeTurnResult, UserTurn } from "./turn-runner";

type JsonRecord = Record<string, unknown>;
type Originator = "user" | "schedule" | "internal";

export type TurnEnqueueResult =
  | { status: "running"; turnId: string }
  | { status: "queued"; queueJobId: string; position: number }
  | { status: "rejected"; reason: "busy" };

export type TurnSnapshot = {
  turnId: string;
  originator: Originator;
  childPid: number | null;
};

export type TurnWorkItem = {
  id?: string;
  userTurn: UserTurn;
  deliverTo: Sink;
  originator: Originator;
};

type QueuedTurn = Required<Pick<TurnWorkItem, "id">> & Omit<TurnWorkItem, "id">;

export type TurnSupervisorOptions = {
  agentName: string;
  makeEventSink: () => Sink;
  createUserTurn: (text: string, images: UserTurn["images"]) => string;
  runTurn: (
    item: QueuedTurn,
    sink: Sink,
    context: {
      turnId: string;
      queueDepthAtStart: number;
      abortSignal: AbortSignal;
      setChild: (child: ChildProcessWithoutNullStreams) => void;
      clearChild: () => void;
    }
  ) => Promise<RunClaudeTurnResult>;
  getSessionId: () => string;
  publishCompletion: (event: TurnCompletionEvent) => void;
  log: (level: "INFO" | "ERROR", message: string, context?: JsonRecord) => void;
};

export type TurnCompletionEvent = {
  turnId: string;
  sessionId: string;
  agentName: string;
  originator: Originator;
  durationMs: number;
  outcome: RunClaudeTurnResult["outcome"];
  lastStdoutAt: string | null;
  bytesStreamed: number;
  queueDepthAtStart: number;
};

export class TurnSupervisor {
  private readonly queue: QueuedTurn[] = [];
  private current: { item: QueuedTurn; child: ChildProcessWithoutNullStreams | null; abort: AbortController } | null = null;
  private stopped = false;
  private draining = false;

  constructor(private readonly options: TurnSupervisorOptions) {}

  start(): void {
    this.stopped = false;
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.abort();
  }

  async enqueue(item: TurnWorkItem): Promise<TurnEnqueueResult> {
    if (this.current || this.queue.length > 0) {
      if (item.originator === "schedule") {
        return { status: "rejected", reason: "busy" };
      }

      const queued: QueuedTurn = {
        ...item,
        id: item.id ?? randomUUID(),
        deliverTo: this.options.makeEventSink()
      };
      this.queue.push(queued);
      return { status: "queued", queueJobId: queued.id, position: this.queue.length };
    }

    const queued: QueuedTurn = { ...item, id: item.id ?? randomUUID() };
    this.queue.push(queued);
    void this.drain();
    return { status: "running", turnId: queued.id };
  }

  currentTurn(): TurnSnapshot | null {
    if (!this.current) {
      return null;
    }

    return {
      turnId: this.current.item.id,
      originator: this.current.item.originator,
      childPid: this.current.child?.pid ?? null
    };
  }

  async steer(turn: UserTurn): Promise<{ status: "queued"; pendingCount: number }> {
    if (!this.current?.child || this.current.child.exitCode !== null || !this.current.child.stdin.writable) {
      throw new Error("no active turn to steer");
    }

    this.current.child.stdin.write(this.options.createUserTurn(turn.text, turn.images));
    return { status: "queued", pendingCount: this.queue.length };
  }

  async abort(): Promise<void> {
    this.current?.abort.abort();
  }

  queueSnapshot(): GhostQueueState {
    return {
      steering: [],
      followUp: this.queue.map((item) => item.userTurn.text),
      pendingCount: this.queue.length
    };
  }

  clearQueue(): GhostQueueClearResponse {
    const response: GhostQueueClearResponse = {
      cleared: {
        steering: [],
        followUp: this.queue.map((item) => item.userTurn.text)
      }
    };
    this.queue.length = 0;
    return response;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) {
      return;
    }

    this.draining = true;

    try {
      while (!this.current && this.queue.length > 0 && !this.stopped) {
        const item = this.queue.shift();
        if (!item) {
          return;
        }

        const abort = new AbortController();
        const queueDepthAtStart = this.queue.length;
        this.current = { item, child: null, abort };

        try {
          const result = await this.options.runTurn(item, item.deliverTo, {
            turnId: item.id,
            queueDepthAtStart,
            abortSignal: abort.signal,
            setChild: (child) => {
              if (this.current?.item.id === item.id) {
                this.current.child = child;
              }
            },
            clearChild: () => {
              if (this.current?.item.id === item.id) {
                this.current.child = null;
              }
            }
          });

          this.completeTurn(item, result, queueDepthAtStart);
        } catch (error) {
          this.options.log("ERROR", "Ghost turn runner failed", {
            turn_id: item.id,
            error: error instanceof Error ? error.message : String(error)
          });
          item.deliverTo.sendLine({
            type: "aborted",
            reason: "runner_error",
            sessionId: this.options.getSessionId()
          });
          item.deliverTo.end();
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0 && !this.current && !this.stopped) {
        void this.drain();
      }
    }
  }

  private completeTurn(item: QueuedTurn, result: RunClaudeTurnResult, queueDepthAtStart: number): void {
    const event: TurnCompletionEvent = {
      turnId: item.id,
      sessionId: this.options.getSessionId(),
      agentName: this.options.agentName,
      originator: item.originator,
      durationMs: result.durationMs,
      outcome: result.outcome,
      lastStdoutAt: result.lastStdoutAt,
      bytesStreamed: result.bytesStreamed,
      queueDepthAtStart
    };

    this.options.log("INFO", "Ghost turn completed", {
      turn_id: event.turnId,
      session_id: event.sessionId,
      agent_name: event.agentName,
      originator: event.originator,
      duration_ms: event.durationMs,
      outcome: event.outcome,
      last_stdout_at: event.lastStdoutAt,
      bytes_streamed: event.bytesStreamed,
      queue_depth_at_start: event.queueDepthAtStart
    });
    this.options.publishCompletion(event);
  }
}
