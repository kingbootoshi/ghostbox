import type { ServerResponse } from "node:http";
import type { GhostMessage, RealtimeEvent } from "../src/types";

type JsonRecord = Record<string, unknown>;

type LogFn = (level: "INFO" | "ERROR", message: string, context?: JsonRecord) => void;

type TurnMessageEvent = Omit<Extract<RealtimeEvent, { type: "ghost.turn-message" }>, "id" | "at" | "ghostName">;

export interface Sink {
  /**
   * Writes one ghost stream line. Implementations preserve call order while the
   * sink is open. Calls after end() are ignored and must not throw.
   */
  sendLine(line: GhostMessage): void;
  /**
   * Marks the sink complete. end() is idempotent. Runners must parse all
   * pending stdout before calling this because post-end sendLine() calls drop.
   */
  end(): void;
}

export class HttpStreamSink implements Sink {
  constructor(private readonly res: ServerResponse) {}

  sendLine(line: GhostMessage): void {
    if (!this.res.writableEnded) {
      if (!this.res.headersSent) {
        this.res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      }
      this.res.write(`${JSON.stringify(line)}\n`);
    }
  }

  end(): void {
    if (!this.res.writableEnded) {
      if (!this.res.headersSent) {
        this.res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      }
      this.res.end();
    }
  }
}

export class EventSink implements Sink {
  private sequence = 0;
  private ended = false;
  private completionQueued = false;
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      hostBase: string;
      ghostName: string;
      authToken: string | null;
      getSessionId: () => string;
      log: LogFn;
    }
  ) {}

  sendLine(line: GhostMessage): void {
    if (this.ended) {
      return;
    }

    const event = this.toEvent(line);
    if (event) {
      this.enqueuePublish(event);
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.enqueueCompletion();
  }

  private toEvent(line: GhostMessage): TurnMessageEvent | null {
    if (line.type === "assistant") {
      return this.createEvent("assistant", line.text);
    }

    if (line.type === "result") {
      return this.createCompletionEvent(line.sessionId);
    }

    if (line.type === "aborted") {
      return this.createEvent("system", line.reason, new Date().toISOString());
    }

    if (line.type === "rejected") {
      return this.createEvent("system", line.reason, new Date().toISOString());
    }

    return null;
  }

  private enqueueCompletion(): void {
    const event = this.createCompletionEvent(this.options.getSessionId());
    if (event) {
      this.enqueuePublish(event);
    }
  }

  private createCompletionEvent(sessionId: string): TurnMessageEvent | null {
    if (this.completionQueued) {
      return null;
    }
    this.completionQueued = true;
    this.sequence += 1;
    return {
      type: "ghost.turn-message",
      sessionId,
      role: "system",
      text: "",
      sequence: this.sequence,
      completedAt: new Date().toISOString()
    };
  }

  private createEvent(role: "assistant" | "system", text: string, completedAt?: string): TurnMessageEvent {
    this.sequence += 1;
    return {
      type: "ghost.turn-message",
      sessionId: this.options.getSessionId(),
      role,
      text,
      sequence: this.sequence,
      ...(completedAt ? { completedAt } : {})
    };
  }

  private enqueuePublish(event: TurnMessageEvent): void {
    this.publishQueue = this.publishQueue
      .then(() => this.publish(event))
      .catch((error) => {
        this.options.log("ERROR", "Failed to publish turn message event", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async publish(event: TurnMessageEvent): Promise<void> {
    const response = await fetch(`${this.options.hostBase}/internal/realtime-publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.authToken ? { Authorization: `Bearer ${this.options.authToken}` } : {})
      },
      body: JSON.stringify({
        ghostName: this.options.ghostName,
        event
      })
    });

    if (!response.ok) {
      throw new Error(`Host realtime publish failed with status ${response.status}.`);
    }
  }
}

export class NullSink implements Sink {
  sendLine(_line: GhostMessage): void {}

  end(): void {}
}
