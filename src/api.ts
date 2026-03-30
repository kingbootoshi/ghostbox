import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  type ApiAuthContext,
  authenticateApiToken,
  deleteMail,
  ensureApiAdminToken,
  getPublicConfig,
  type LegacyConfig,
  listMail,
  markMailRead,
  normalizeGhostImages,
  normalizeStreamingBehavior,
  resolveAllowedCorsOrigins,
  sendMail,
  updateStoredConfig
} from "./auth-config";
import { createLogger } from "./logger";
import { getAuthStatus } from "./oauth";
import {
  abortGhost,
  clearGhostQueue,
  deleteGhostSession,
  generateApiKey,
  getConfig,
  getGhost,
  getGhostHealth,
  getGhostHistory,
  getGhostQueue,
  getGhostSessions,
  getGhostStats,
  killBackgroundTask,
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
  sendMessage,
  spawnGhost,
  steerGhost,
  switchGhostSession,
  updateGhost,
  wakeGhost
} from "./orchestrator";
import { scheduleManager } from "./schedule-manager";
import type { GhostboxConfig, GhostboxConfigUpdate } from "./types";
import { commitVault } from "./vault";
import { deleteVaultFile, listVaultDirectory, readVaultFile, writeVaultFile } from "./vault-routes";

const DEFAULT_PORT = 8008;
const port = Number(process.env.GHOSTBOX_PORT) || DEFAULT_PORT;
const log = createLogger("api");

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

const getApiErrorStatus = (error: unknown): ApiStatusCode | null => {
  if (error instanceof ApiError) {
    return error.status;
  }

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 429 || status === 500) {
      return status;
    }
  }

  return null;
};

const getErrorStatus = (error: unknown): ApiStatusCode => {
  const apiStatus = getApiErrorStatus(error);
  if (apiStatus) {
    return apiStatus;
  }

  const message = error instanceof Error ? error.message : "Internal server error";

  if (message.includes("not found")) {
    return 404;
  }

  if (message.includes("extension not loaded")) {
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
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    log.error({ method: c.req.method, path: c.req.path, err: error }, "Failed to read request body");
    throw new ApiError(400, "Could not read request body");
  }
};

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

const enforceGhostScope = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
  const auth = c.var.apiAuth;

  if (auth.ghostName === null) {
    await next();
    return;
  }

  if (auth.ghostName !== c.req.param("name")) {
    return c.json({ error: "Forbidden" }, { status: 403 });
  }

  await next();
};

app.use(
  "/api/*",
  cors({
    origin: async (origin) => {
      if (!origin) {
        return null;
      }

      const state = await loadState();
      const allowedOrigins = resolveAllowedCorsOrigins(state.config as GhostboxConfig);
      return allowedOrigins.includes(origin) ? origin : null;
    }
  })
);

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
    const auth = await authenticateApiToken(c.req.header("authorization"));

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

app.use("/api/ghosts/:name", enforceGhostScope);
app.use("/api/ghosts/:name/*", enforceGhostScope);

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
    const result = await sendMail(body, c.var.apiAuth);

    if (result.rateLimited) {
      return c.json({ error: "Rate limit exceeded", retryAfter: result.retryAfter }, { status: 429 });
    }

    return c.json(result.response);
  })
);

app.get("/api/mail/:ghostName", (c) =>
  handleRoute(c, async () => {
    const unreadOnly = c.req.query("unread") === "true";
    return c.json(await listMail(c.req.param("ghostName"), unreadOnly, c.var.apiAuth));
  })
);

app.post("/api/mail/:id/read", (c) =>
  handleRoute(c, async () => {
    return c.json(await markMailRead(c.req.param("id"), c.var.apiAuth));
  })
);

app.delete("/api/mail/:id", (c) =>
  handleRoute(c, async () => {
    return c.json(await deleteMail(c.req.param("id"), c.var.apiAuth));
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
    return c.json(await listVaultDirectory(c.req.param("name"), c.req.query("path")));
  })
);

app.get("/api/ghosts/:name/vault/read", (c) =>
  handleRoute(c, async () => {
    return c.json(await readVaultFile(c.req.param("name"), c.req.query("path")));
  })
);

app.put("/api/ghosts/:name/vault/write", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultWriteBody>(c);
    const inputPath = typeof body.path === "string" ? body.path : undefined;
    const content = typeof body.content === "string" ? body.content : null;
    return c.json(await writeVaultFile(c.req.param("name"), inputPath, content));
  })
);

app.delete("/api/ghosts/:name/vault/delete", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultDeleteBody>(c);
    const inputPath = typeof body.path === "string" ? body.path : undefined;
    return c.json(await deleteVaultFile(c.req.param("name"), inputPath));
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
    return c.json(await getPublicConfig());
  })
);

app.put("/api/config", (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<ConfigUpdateBody>(c);
    return c.json(await updateStoredConfig(body));
  })
);

app.post("/api/ghosts/:name/reload", (c) =>
  handleRoute(c, async () => {
    await reloadGhost(c.req.param("name"));
    return c.json({ status: "reloaded" });
  })
);

app.post("/api/ghosts/:name/abort", (c) =>
  handleRoute(c, async () => {
    await abortGhost(c.req.param("name"));
    return c.json({ status: "aborted" });
  })
);

app.post("/api/ghosts/:name/tasks/:taskId/kill", (c) =>
  handleRoute(c, async () => {
    const result = await killBackgroundTask(c.req.param("name"), c.req.param("taskId"));
    return c.json(result);
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

  let boundPort = port;
  let server: ReturnType<typeof createServer> | null = null;

  const tryListen = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer(async (req, res) => {
        const url = `http://localhost:${p}${req.url ?? "/"}`;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers[key] = value;
          }
        }
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const reqBody = hasBody
          ? await new Promise<Buffer>((resolveBody) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => resolveBody(Buffer.concat(chunks)));
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
              if (done) {
                break;
              }
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

  reconcileGhostStates()
    .then(({ started, marked }) => {
      if (marked.length > 0) {
        log.info({ started, marked }, "Ghost state reconciliation complete");
      }
      scheduleManager.start();
    })
    .catch((error) => {
      log.error({ err: error }, "Ghost state reconciliation failed");
      scheduleManager.start();
    });

  const shutdown = async () => {
    log.info("Shutting down - stopping ghost containers...");
    scheduleManager.stop();
    try {
      const ghosts = await listGhosts();
      for (const [name, ghost] of Object.entries(ghosts)) {
        if (ghost.status !== "running") {
          continue;
        }
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
export { ensureApiAdminToken } from "./auth-config";
export { ScheduleManager } from "./schedule-manager";
export default app;
