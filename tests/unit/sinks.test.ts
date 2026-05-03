import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

import { EventSink, HttpStreamSink, NullSink } from "../../docker/sinks";
import type { GhostMessage } from "../../src/types";

type JsonRecord = Record<string, unknown>;

class MockServerResponse {
  writableEnded = false;
  headersSent = false;
  statusCode = 0;
  readonly chunks: string[] = [];

  writeHead(statusCode: number, _headers: OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    if (!this.writableEnded) {
      this.chunks.push(chunk);
    }
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }
}

const originalFetch = globalThis.fetch;

const waitFor = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
};

const parseEventBodies = (calls: Array<[string | URL | Request, RequestInit | undefined]>): JsonRecord[] =>
  calls.map(([_input, init]) => JSON.parse(String(init?.body ?? "{}")) as JsonRecord);

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("HttpStreamSink", () => {
  test("writes ndjson lines, ends idempotently, and drops post-end lines", () => {
    const response = new MockServerResponse();
    const sink = new HttpStreamSink(response as unknown as ServerResponse);

    sink.sendLine({ type: "assistant", text: "hello" });
    sink.end();
    sink.end();
    sink.sendLine({ type: "assistant", text: "late" });

    expect(response.statusCode).toBe(200);
    expect(response.writableEnded).toBe(true);
    expect(response.chunks).toEqual(['{"type":"assistant","text":"hello"}\n']);
  });
});

describe("EventSink", () => {
  test("publishes each line immediately in order", async () => {
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = new EventSink({
      hostBase: "http://host",
      ghostName: "demo",
      authToken: "token",
      getSessionId: () => "session-1",
      log: () => {}
    });

    sink.sendLine({ type: "assistant", text: "a" });
    await waitFor(() => calls.length === 1);
    sink.sendLine({ type: "assistant", text: "b" });
    sink.end();
    await waitFor(() => calls.length === 3);

    const bodies = parseEventBodies(calls);
    const events = bodies.map((body) => body.event as JsonRecord);
    expect(events.map((event) => event.text)).toEqual(["a", "b", ""]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(typeof events[2]?.completedAt).toBe("string");
  });

  test("swallows publish failures and does not duplicate final assistant text", async () => {
    const logged: JsonRecord[] = [];
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const sink = new EventSink({
      hostBase: "http://host",
      ghostName: "demo",
      authToken: null,
      getSessionId: () => "session-1",
      log: (_level, message, context) => logged.push({ message, ...(context ?? {}) })
    });

    expect(() => {
      sink.sendLine({ type: "assistant", text: "final" });
      sink.sendLine({ type: "result", text: "final", sessionId: "session-1" });
      sink.end();
      sink.sendLine({ type: "assistant", text: "late" });
    }).not.toThrow();

    await waitFor(() => calls.length === 2 && logged.length > 0);
    const events = parseEventBodies(calls).map((body) => body.event as JsonRecord);
    expect(events.map((event) => event.text)).toEqual(["final", ""]);
    expect(events[1]?.role).toBe("system");
    expect(typeof events[1]?.completedAt).toBe("string");
  });
});

describe("NullSink", () => {
  test("silently consumes lines and end calls", () => {
    const sink = new NullSink();
    const line: GhostMessage = { type: "assistant", text: "ignored" };
    expect(() => {
      sink.sendLine(line);
      sink.end();
      sink.end();
    }).not.toThrow();
  });
});
