import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { app, ensureApiAdminToken, ScheduleManager } from "../../src/api";
import type { GhostRuntimeMeta } from "../../src/types";
import { createConfig, createGhostState, createState, createTestHome } from "../support/test-state";

type TestHome = Awaited<ReturnType<typeof createTestHome>>;
const TEST_ADMIN_TOKEN = "test-admin-token";

const postJson = (path: string, body: unknown): Promise<Response> => {
  return app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

const putJson = (path: string, body: unknown): Promise<Response> => {
  return app.request(path, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

const apiHeaders = (token: string, headers: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  ...headers
});

const postMailJson = (path: string, token: string, body: unknown): Promise<Response> => {
  return app.request(path, {
    method: "POST",
    headers: apiHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });
};

const deleteWithMailAuth = (path: string, token: string): Promise<Response> => {
  return app.request(path, {
    method: "DELETE",
    headers: apiHeaders(token)
  });
};

const getWithMailAuth = (path: string, token: string): Promise<Response> => {
  return app.request(path, {
    headers: apiHeaders(token)
  });
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const startGhostStub = async (
  handler: (req: IncomingMessage, res: ServerResponse, requests: string[]) => void | Promise<void>
): Promise<{
  port: number;
  requests: string[];
  close: () => Promise<void>;
}> => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    Promise.resolve(handler(req, res, requests)).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start ghost stub");
  }

  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
};

describe("api route validation", () => {
  let testHome: TestHome;
  let previousAdminTokenEnv: string | undefined;
  let previousMailUserTokenEnv: string | undefined;
  let previousCorsOriginsEnv: string | undefined;

  beforeEach(async () => {
    previousAdminTokenEnv = process.env.GHOSTBOX_ADMIN_TOKEN;
    previousMailUserTokenEnv = process.env.GHOSTBOX_MAIL_USER_TOKEN;
    previousCorsOriginsEnv = process.env.GHOSTBOX_CORS_ORIGINS;
    delete process.env.GHOSTBOX_ADMIN_TOKEN;
    delete process.env.GHOSTBOX_MAIL_USER_TOKEN;
    delete process.env.GHOSTBOX_CORS_ORIGINS;
    testHome = await createTestHome();
  });

  afterEach(async () => {
    if (previousAdminTokenEnv === undefined) {
      delete process.env.GHOSTBOX_ADMIN_TOKEN;
    } else {
      process.env.GHOSTBOX_ADMIN_TOKEN = previousAdminTokenEnv;
    }

    if (previousMailUserTokenEnv === undefined) {
      delete process.env.GHOSTBOX_MAIL_USER_TOKEN;
    } else {
      process.env.GHOSTBOX_MAIL_USER_TOKEN = previousMailUserTokenEnv;
    }

    if (previousCorsOriginsEnv === undefined) {
      delete process.env.GHOSTBOX_CORS_ORIGINS;
    } else {
      process.env.GHOSTBOX_CORS_ORIGINS = previousCorsOriginsEnv;
    }

    await testHome.cleanup();
  });

  test("GET /api/config masks sensitive values and reports status flags", async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          githubToken: "github-token-1234567890",
          telegramToken: "telegram-token-1234567890"
        })
      })
    );

    const response = await app.request("/api/config", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      telegramToken: "telegram-tok...7890",
      githubToken: "github-token...7890",
      githubRemote: "https://github.com/example/repo.git",
      defaultModel: "anthropic/claude-sonnet-4-6",
      defaultProvider: "anthropic",
      imageName: "ghostbox-agent",
      imageVersion: "gb-deadbeef",
      observerModel: "openai/gpt-4o-mini",
      hasSensitive: {
        githubToken: true,
        telegramToken: true
      }
    });
  });

  test("PUT /api/config trims values, clears nullable fields, and preserves masked secrets", async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          githubToken: "github-token-1234567890",
          telegramToken: "telegram-token-1234567890",
          githubRemote: "https://github.com/example/repo.git"
        })
      })
    );

    const response = await putJson("/api/config", {
      defaultProvider: "openai",
      defaultModel: " openai/gpt-4.1 ",
      imageName: " ghostbox-next ",
      githubRemote: "   ",
      githubToken: "github-token...7890",
      telegramToken: null
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      telegramToken: "",
      githubToken: "github-token...7890",
      githubRemote: null,
      defaultModel: "openai/gpt-4.1",
      defaultProvider: "openai",
      imageName: "ghostbox-next",
      imageVersion: "gb-deadbeef",
      observerModel: "openai/gpt-4o-mini",
      hasSensitive: {
        githubToken: true,
        telegramToken: false
      }
    });

    const savedState = JSON.parse(await Bun.file(testHome.statePath).text());
    expect(savedState.config.githubToken).toBe("github-token-1234567890");
    expect(savedState.config.telegramToken).toBe("");
    expect(savedState.config.githubRemote).toBeNull();
  });

  test("PUT /api/config rejects invalid JSON bodies", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: apiHeaders(TEST_ADMIN_TOKEN, { "Content-Type": "application/json" }),
      body: "{"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("Invalid JSON body")
    });
  });

  test("GET /api/health bypasses auth and returns ok", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("GET /api/ghosts/:name/timeline rejects invalid pagination query values", async () => {
    const invalidLimit = await app.request("/api/ghosts/demo/timeline?limit=abc", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toEqual({ error: "Invalid timeline limit." });

    const invalidCursor = await app.request("/api/ghosts/demo/timeline?limit=25&before=-1", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toEqual({ error: "Invalid timeline cursor." });
  });

  test("GET /api/ghosts/:name/runtime/meta proxies adapter runtime meta", async () => {
    const runtimeMeta: GhostRuntimeMeta = {
      adapter: "claude-code",
      runtimeVersion: "node/v22.15.0",
      imageVersion: "gb-meta1234",
      supportedCapabilities: ["message", "history", "sessions", "stats", "commands"],
      supportedCommands: [{ name: "/help", description: "List available slash commands." }],
      currentModel: "claude-sonnet-4-6",
      currentSessionId: "session-123"
    };
    const stub = await startGhostStub((req, res) => {
      if (req.method === "GET" && req.url === "/runtime/meta") {
        sendJson(res, 200, runtimeMeta);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    });

    try {
      await testHome.writeState(
        createState({
          ghosts: {
            demo: createGhostState({ portBase: stub.port })
          }
        })
      );

      const response = await app.request("/api/ghosts/demo/runtime/meta", {
        headers: apiHeaders(TEST_ADMIN_TOKEN)
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(runtimeMeta);
      expect(stub.requests).toEqual(["/runtime/meta"]);
    } finally {
      await stub.close();
    }
  });

  test("POST /api/ghosts/:name/reload fails fast when Claude runtime meta does not support reload", async () => {
    const stub = await startGhostStub((req, res) => {
      if (req.method === "GET" && req.url === "/runtime/meta") {
        sendJson(res, 200, {
          adapter: "claude-code",
          runtimeVersion: "node/v22.15.0",
          imageVersion: "gb-meta1234",
          supportedCapabilities: ["message", "history", "sessions", "stats", "commands"],
          supportedCommands: [{ name: "/help", description: "List available slash commands." }],
          currentModel: "claude-sonnet-4-6",
          currentSessionId: null
        } satisfies GhostRuntimeMeta);
        return;
      }

      sendJson(res, 500, { error: "reload endpoint should not be called" });
    });

    try {
      await testHome.writeState(
        createState({
          ghosts: {
            demo: createGhostState({ portBase: stub.port })
          }
        })
      );

      const response = await app.request("/api/ghosts/demo/reload", {
        method: "POST",
        headers: apiHeaders(TEST_ADMIN_TOKEN)
      });

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: "Reload is not supported by the claude-code adapter."
      });
      expect(stub.requests).toEqual(["/runtime/meta"]);
    } finally {
      await stub.close();
    }
  });

  test("POST /api/ghosts/:name/tasks/:taskId/kill fails fast when Claude runtime meta does not support background task kill", async () => {
    const stub = await startGhostStub((req, res) => {
      if (req.method === "GET" && req.url === "/runtime/meta") {
        sendJson(res, 200, {
          adapter: "claude-code",
          runtimeVersion: "node/v22.15.0",
          imageVersion: "gb-meta1234",
          supportedCapabilities: ["message", "history", "sessions", "stats", "commands"],
          supportedCommands: [{ name: "/help", description: "List available slash commands." }],
          currentModel: "claude-sonnet-4-6",
          currentSessionId: null
        } satisfies GhostRuntimeMeta);
        return;
      }

      sendJson(res, 500, { error: "task kill endpoint should not be called" });
    });

    try {
      await testHome.writeState(
        createState({
          ghosts: {
            demo: createGhostState({ portBase: stub.port })
          }
        })
      );

      const response = await app.request("/api/ghosts/demo/tasks/task-1/kill", {
        method: "POST",
        headers: apiHeaders(TEST_ADMIN_TOKEN)
      });

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: "Background task killing is not supported by the claude-code adapter."
      });
      expect(stub.requests).toEqual(["/runtime/meta"]);
    } finally {
      await stub.close();
    }
  });

  test("non-mail API routes require bearer auth", async () => {
    const unauthorizedResponse = await app.request("/api/config");
    expect(unauthorizedResponse.status).toBe(401);
    expect(await unauthorizedResponse.json()).toEqual({ error: "Unauthorized" });

    const authorizedResponse = await app.request("/api/config", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(authorizedResponse.status).toBe(200);
  });

  test("ensureApiAdminToken generates and persists a token when config is missing one", async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          adminToken: undefined
        })
      })
    );

    const adminToken = await ensureApiAdminToken();
    const savedState = JSON.parse(await Bun.file(testHome.statePath).text());

    expect(adminToken).toMatch(/^[a-f0-9]{64}$/);
    expect(savedState.config.adminToken).toBe(adminToken);
  });

  test("CORS allows configured origins and blocks unknown ones", async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          corsOrigins: ["https://app.example"]
        })
      })
    );

    const allowedResponse = await app.request("/api/health", {
      headers: { Origin: "https://app.example" }
    });
    expect(allowedResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");

    const blockedResponse = await app.request("/api/health", {
      headers: { Origin: "https://blocked.example" }
    });
    expect(blockedResponse.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("CORS merges env origins with default localhost allowlist", async () => {
    process.env.GHOSTBOX_CORS_ORIGINS = "https://env.example";

    const localhostResponse = await app.request("/api/health", {
      headers: { Origin: "http://localhost:3000" }
    });
    expect(localhostResponse.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");

    const envResponse = await app.request("/api/health", {
      headers: { Origin: "https://env.example" }
    });
    expect(envResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://env.example");
  });

  test("POST /api/ghosts rejects requests with a missing name", async () => {
    const response = await postJson("/api/ghosts", {
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing name" });
  });

  test("POST /api/ghosts rejects provider and model mismatches before spawning", async () => {
    const response = await postJson("/api/ghosts", {
      name: "mismatch",
      provider: "openai",
      model: "anthropic/claude-sonnet-4-6"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Provider mismatch: model uses "anthropic" but provider was "openai".'
    });
  });

  test("POST /api/ghosts/:name/message rejects invalid streaming behavior", async () => {
    const response = await postJson("/api/ghosts/demo/message", {
      prompt: "hello",
      streamingBehavior: "invalid"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid streamingBehavior" });
  });

  test("POST /api/ghosts/:name/message rejects malformed image payloads", async () => {
    const response = await postJson("/api/ghosts/demo/message", {
      prompt: "hello",
      images: [{ mediaType: "image/png" }]
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid images" });
  });

  test("GET /api/ghosts/:name/vault/read rejects path traversal attempts", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState()
        }
      })
    );

    const response = await app.request("/api/ghosts/demo/vault/read?path=../../secret.txt", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid path" });
  });

  test("GET /api/ghosts/:name/vault lists directories before files with API paths", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState()
        }
      })
    );
    await testHome.createVaultFile("demo", "notes/todo.md", "todo");
    await testHome.createVaultFile("demo", "README.md", "hello");

    const response = await app.request("/api/ghosts/demo/vault", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      name: "notes",
      path: "/notes",
      type: "directory"
    });
    expect(payload.entries[1]).toMatchObject({
      name: "README.md",
      path: "/README.md",
      type: "file",
      size: 5
    });
  });

  test("GET /api/ghosts/:name/vault/read returns file contents and normalized path", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState()
        }
      })
    );
    await testHome.createVaultFile("demo", "notes/todo.md", "remember this");

    const response = await app.request("/api/ghosts/demo/vault/read?path=/notes/todo.md", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/notes/todo.md",
      content: "remember this",
      size: 13
    });
  });

  test("schedule routes create, list, and delete schedules on the host", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState()
        }
      })
    );

    const createResponse = await postJson("/api/ghosts/demo/schedules", {
      cron: "0 10 * * *",
      prompt: "Morning check-in",
      timezone: "UTC",
      once: true
    });

    expect(createResponse.status).toBe(201);
    const createdSchedule = await createResponse.json();
    expect(createdSchedule).toMatchObject({
      ghostName: "demo",
      cron: "0 10 * * *",
      prompt: "Morning check-in",
      timezone: "UTC",
      once: true,
      enabled: true,
      lastFired: null
    });
    expect(createdSchedule.id).toEqual(expect.any(String));
    expect(createdSchedule.nextFire).toEqual(expect.any(String));

    const listResponse = await app.request("/api/ghosts/demo/schedules", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([createdSchedule]);

    const schedulesPath = join(testHome.homeDir, ".ghostbox", "schedules.json");
    expect(JSON.parse(await readFile(schedulesPath, "utf8"))).toEqual([createdSchedule]);

    const deleteResponse = await app.request(`/api/ghosts/demo/schedules/${createdSchedule.id}`, {
      method: "DELETE",
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ status: "deleted" });

    const finalListResponse = await app.request("/api/ghosts/demo/schedules", {
      headers: apiHeaders(TEST_ADMIN_TOKEN)
    });
    expect(finalListResponse.status).toBe(200);
    expect(await finalListResponse.json()).toEqual([]);
  });

  test("mail routes require bearer auth", async () => {
    const response = await app.request("/api/mail/demo");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("mail send binds the sender to the authenticated ghost and records who authenticated it", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          binder: createGhostState({
            apiKeys: [{ id: "alpha-key", key: "alpha-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }]
          }),
          recipient: createGhostState({
            containerId: "container-2",
            portBase: 3200,
            apiKeys: [{ id: "beta-key", key: "beta-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }]
          })
        }
      })
    );

    const response = await postMailJson("/api/mail/send", "alpha-token", {
      from: "beta",
      to: "recipient",
      subject: "Hello",
      body: "Message body"
    });

    expect(response.status).toBe(200);

    const mailboxPath = join(testHome.homeDir, ".ghostbox", "mailbox.json");
    const mailbox = JSON.parse(await readFile(mailboxPath, "utf8"));
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]).toMatchObject({
      from: "binder",
      authenticatedBy: "binder",
      to: "recipient",
      subject: "Hello",
      body: "Message body"
    });
  });

  test("mail send allows explicit user mail while preserving the authenticated ghost for audit", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          userproxy: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-user-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    const response = await postMailJson("/api/mail/send", "alpha-user-token", {
      from: "user",
      to: "userproxy",
      subject: "User note",
      body: "Sent as user"
    });

    expect(response.status).toBe(200);

    const mailboxPath = join(testHome.homeDir, ".ghostbox", "mailbox.json");
    const mailbox = JSON.parse(await readFile(mailboxPath, "utf8"));
    expect(mailbox.messages[0]).toMatchObject({
      from: "user",
      authenticatedBy: "userproxy",
      to: "userproxy"
    });
  });

  test("mail inbox access is limited to the authenticated ghost", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          inboxreader: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-inbox-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          }),
          inboxowner: createGhostState({
            containerId: "container-2",
            portBase: 3200,
            apiKeys: [
              { id: "beta-key", key: "beta-inbox-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    const mailboxPath = join(testHome.homeDir, ".ghostbox", "mailbox.json");
    await writeFile(
      mailboxPath,
      JSON.stringify(
        {
          messages: [
            {
              id: "message-1",
              from: "binder",
              authenticatedBy: "binder",
              to: "inboxowner",
              subject: "Private",
              body: "For inboxowner only",
              sentAt: "2026-03-25T00:00:00.000Z",
              readAt: null,
              threadId: null,
              priority: "normal"
            }
          ]
        },
        null,
        2
      )
    );

    const forbiddenResponse = await getWithMailAuth("/api/mail/inboxowner", "alpha-inbox-token");
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({ error: "Forbidden" });

    const allowedResponse = await getWithMailAuth("/api/mail/inboxowner", "beta-inbox-token");
    expect(allowedResponse.status).toBe(200);
    const allowedPayload = await allowedResponse.json();
    expect(allowedPayload.messages).toEqual([
      expect.objectContaining({
        id: "message-1",
        to: "inboxowner"
      })
    ]);
  });

  test("mail read and delete only work for the owning inbox", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          blockedreader: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-read-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          }),
          allowedreader: createGhostState({
            containerId: "container-2",
            portBase: 3200,
            apiKeys: [
              { id: "beta-key", key: "beta-read-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    const mailboxPath = join(testHome.homeDir, ".ghostbox", "mailbox.json");
    await writeFile(
      mailboxPath,
      JSON.stringify(
        {
          messages: [
            {
              id: "message-2",
              from: "binder",
              authenticatedBy: "binder",
              to: "allowedreader",
              subject: "Private",
              body: "For allowedreader only",
              sentAt: "2026-03-25T00:00:00.000Z",
              readAt: null,
              threadId: null,
              priority: "normal"
            }
          ]
        },
        null,
        2
      )
    );

    const forbiddenRead = await postMailJson("/api/mail/message-2/read", "alpha-read-token", {});
    expect(forbiddenRead.status).toBe(403);

    const forbiddenDelete = await deleteWithMailAuth("/api/mail/message-2", "alpha-read-token");
    expect(forbiddenDelete.status).toBe(403);

    const allowedRead = await postMailJson("/api/mail/message-2/read", "beta-read-token", {});
    expect(allowedRead.status).toBe(200);
    expect(await allowedRead.json()).toEqual({ status: "read" });
  });

  test("mail send enforces subject and body size caps", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          sizeghost: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-size-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    const response = await postMailJson("/api/mail/send", "alpha-size-token", {
      to: "sizeghost",
      subject: "x".repeat(201),
      body: "Message body"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Subject exceeds 200 characters" });
  });

  test("mail send rate limits each authenticated sender after ten messages per minute", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          rateghost: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-rate-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    for (let index = 0; index < 10; index += 1) {
      const response = await postMailJson("/api/mail/send", "alpha-rate-token", {
        to: "rateghost",
        subject: `Message ${index}`,
        body: "Message body"
      });

      expect(response.status).toBe(200);
    }

    const limitedResponse = await postMailJson("/api/mail/send", "alpha-rate-token", {
      to: "rateghost",
      subject: "Message 10",
      body: "Message body"
    });

    expect(limitedResponse.status).toBe(429);
    expect(await limitedResponse.json()).toEqual({
      error: "Rate limit exceeded",
      retryAfter: expect.any(Number)
    });
  });

  test("mailbox saves trim oversized inboxes by removing the oldest read messages first", async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          capsender: createGhostState({
            apiKeys: [
              { id: "alpha-key", key: "alpha-cap-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          }),
          cappedinbox: createGhostState({
            containerId: "container-2",
            portBase: 3200,
            apiKeys: [
              { id: "beta-key", key: "beta-cap-token", label: "default", createdAt: "2026-03-25T00:00:00.000Z" }
            ]
          })
        }
      })
    );

    const mailboxPath = join(testHome.homeDir, ".ghostbox", "mailbox.json");
    await writeFile(
      mailboxPath,
      JSON.stringify(
        {
          messages: Array.from({ length: 500 }, (_, index) => ({
            id: `message-${index + 1}`,
            from: "capsender",
            authenticatedBy: "capsender",
            to: "cappedinbox",
            subject: `Subject ${index + 1}`,
            body: `Body ${index + 1}`,
            sentAt: `2026-03-25T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
            readAt: index === 0 ? "2026-03-25T01:00:00.000Z" : null,
            threadId: null,
            priority: "normal"
          }))
        },
        null,
        2
      )
    );

    const response = await postMailJson("/api/mail/send", "alpha-cap-token", {
      to: "cappedinbox",
      subject: "Newest",
      body: "Newest body"
    });

    expect(response.status).toBe(200);

    const mailbox = JSON.parse(await readFile(mailboxPath, "utf8"));
    const ids = mailbox.messages.map((message: { id: string }) => message.id);
    expect(ids).toHaveLength(500);
    expect(ids).not.toContain("message-1");
    expect(ids).toContain("message-2");
  });

  test("ScheduleManager disables one-shot schedules after they fire", async () => {
    const schedulesPath = join(testHome.homeDir, ".ghostbox", "schedules.json");
    await writeFile(
      schedulesPath,
      JSON.stringify(
        [
          {
            id: "schedule-1",
            ghostName: "demo",
            cron: "* * * * *",
            prompt: "Ping",
            timezone: "UTC",
            once: true,
            enabled: true,
            createdAt: "2026-03-25T11:00:00.000Z",
            lastFired: null,
            nextFire: "2026-03-25T11:59:00.000Z"
          }
        ],
        null,
        2
      ),
      "utf8"
    );

    const fired: string[] = [];
    const manager = new ScheduleManager(async (schedule) => {
      fired.push(schedule.id);
    });

    await manager.processDueSchedules(Date.parse("2026-03-25T12:00:00.000Z"));

    expect(fired).toEqual(["schedule-1"]);

    const savedSchedules = JSON.parse(await readFile(schedulesPath, "utf8"));
    expect(savedSchedules).toHaveLength(1);
    expect(savedSchedules[0]).toMatchObject({
      id: "schedule-1",
      enabled: false,
      nextFire: null
    });
    expect(savedSchedules[0].lastFired).toBe("2026-03-25T12:00:00.000Z");
  });
});
