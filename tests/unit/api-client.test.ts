import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { apiClient } from "../../src/tui/api-client";
import { createTestHome } from "../support/test-state";

type TestHome = Awaited<ReturnType<typeof createTestHome>>;

describe("tui api client remote config", () => {
  let testHome: TestHome;
  const originalFetch = globalThis.fetch;
  const originalApiUrl = process.env.GHOSTBOX_API_URL;
  const originalApiToken = process.env.GHOSTBOX_API_TOKEN;

  beforeEach(async () => {
    testHome = await createTestHome();
    delete process.env.GHOSTBOX_API_URL;
    delete process.env.GHOSTBOX_API_TOKEN;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;

    if (originalApiUrl === undefined) {
      delete process.env.GHOSTBOX_API_URL;
    } else {
      process.env.GHOSTBOX_API_URL = originalApiUrl;
    }

    if (originalApiToken === undefined) {
      delete process.env.GHOSTBOX_API_TOKEN;
    } else {
      process.env.GHOSTBOX_API_TOKEN = originalApiToken;
    }

    await testHome.cleanup();
  });

  test("request() falls back to remote.json and adds bearer auth", async () => {
    const remotePath = join(testHome.homeDir, ".ghostbox", "remote.json");
    await mkdir(join(testHome.homeDir, ".ghostbox"), { recursive: true });
    await writeFile(
      remotePath,
      JSON.stringify({
        url: "https://remote.example",
        token: "remote-token"
      }),
      "utf8"
    );

    let requestUrl = "";
    let requestHeaders: Headers | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    await apiClient.listGhosts();

    expect(requestUrl).toBe("https://remote.example/api/ghosts");
    expect(requestHeaders?.get("Authorization")).toBe("Bearer remote-token");
  });

  test("streamMessage() prefers env vars over remote.json and sends bearer auth", async () => {
    const remotePath = join(testHome.homeDir, ".ghostbox", "remote.json");
    await mkdir(join(testHome.homeDir, ".ghostbox"), { recursive: true });
    await writeFile(
      remotePath,
      JSON.stringify({
        url: "https://remote.example",
        token: "remote-token"
      }),
      "utf8"
    );

    process.env.GHOSTBOX_API_URL = "https://env.example";
    process.env.GHOSTBOX_API_TOKEN = "env-token";

    let requestUrl = "";
    let requestHeaders: Headers | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestHeaders = new Headers(init?.headers);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"assistant","text":"hello"}\n\n' + "event: done\ndata:\n\n"
            )
          );
          controller.close();
        }
      });

      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    }) as typeof fetch;

    const messages = [];
    for await (const message of apiClient.streamMessage("demo", "hello")) {
      messages.push(message);
    }

    expect(messages).toEqual([{ type: "assistant", text: "hello" }]);
    expect(requestUrl).toBe("https://env.example/api/ghosts/demo/message");
    expect(requestHeaders?.get("Authorization")).toBe("Bearer env-token");
  });
});
