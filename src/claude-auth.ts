import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createLogger } from "./logger";
import { readAuthTokens, writeAuthTokens } from "./oauth";
import type { AuthTokenStore, ClaudeCodeTokenRecord } from "./types";
import { getHomeDirectory } from "./utils";

const SETUP_TOKEN_PATTERN = /sk-ant-[^\s"'`]+/g;
const EXPIRY_WARNING_BUFFER_MS = 5 * 60 * 1000;
const CLAUDE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_TOKEN_LIFETIME_SECONDS = 31_536_000;
const log = createLogger("claude-auth");
let claudeTokenRefresherStarted = false;

type ClaudeCredentialEnvelope = {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    scopes?: unknown;
    subscriptionType?: unknown;
  };
};

const toClaudeCodeTokenRecord = (
  value: ClaudeCredentialEnvelope["claudeAiOauth"] | undefined,
  source: ClaudeCodeTokenRecord["source"]
): ClaudeCodeTokenRecord | null => {
  if (!value || typeof value.accessToken !== "string" || value.accessToken.trim().length === 0) {
    return null;
  }

  return {
    type: "claude-code",
    accessToken: value.accessToken,
    ...(typeof value.refreshToken === "string" && value.refreshToken.trim().length > 0
      ? { refreshToken: value.refreshToken }
      : {}),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    source
  };
};

const saveClaudeCodeToken = async (record: ClaudeCodeTokenRecord): Promise<void> => {
  const store = await readAuthTokens();
  const nextStore: AuthTokenStore = {
    ...store,
    claudeCode: record
  };
  await writeAuthTokens(nextStore);
};

async function readKeychainClaudeToken(): Promise<ClaudeCodeTokenRecord | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = nodeSpawn("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Failed to read Claude Code token from Keychain."));
        return;
      }

      resolve(stdout.trim());
    });
  }).catch(() => null);

  if (!output) {
    return null;
  }

  let parsed: ClaudeCredentialEnvelope;
  try {
    parsed = JSON.parse(output) as ClaudeCredentialEnvelope;
  } catch {
    return null;
  }

  return toClaudeCodeTokenRecord(parsed.claudeAiOauth, "keychain");
}

async function runSetupToken(): Promise<ClaudeCodeTokenRecord> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("claude", ["setup-token"], {
      stdio: ["inherit", "pipe", "inherit"]
    });

    const stdoutChunks: Buffer[] = [];

    const clearStdoutChunks = (): void => {
      for (const chunk of stdoutChunks) {
        chunk.fill(0);
      }
      stdoutChunks.length = 0;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        clearStdoutChunks();
        reject(new Error(`claude setup-token failed with exit code ${code ?? 1}.`));
        return;
      }

      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const matches = stdoutBuffer.toString("utf8").match(SETUP_TOKEN_PATTERN);
      stdoutBuffer.fill(0);
      clearStdoutChunks();
      const accessToken = matches?.at(-1);
      if (!accessToken) {
        reject(new Error("claude setup-token did not print a Claude Code token."));
        return;
      }

      process.stdout.write("Claude Code token captured.\n");

      resolve({
        type: "claude-code",
        accessToken,
        source: "setup-token"
      });
    });
  });
}

type TokenExchangeResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

async function loginClaudeCodeDirect(): Promise<ClaudeCodeTokenRecord> {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: "user:inference",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });

  const authUrl = `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`;

  process.stdout.write("\nOpen this URL in the browser for the account you want to use:\n\n");
  process.stdout.write(`  ${authUrl}\n\n`);
  process.stdout.write("After authorizing, paste the code shown on screen.\n\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code: string;
  try {
    code = await rl.question("Code: ");
  } finally {
    rl.close();
  }

  const cleaned = code.trim().split("#")[0]?.split("&")[0] ?? code.trim();
  if (!cleaned) {
    throw new Error("No code provided.");
  }

  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: cleaned,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: codeVerifier,
      state,
      expires_in: CLAUDE_TOKEN_LIFETIME_SECONDS
    }),
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as TokenExchangeResponse;
  if (!data.access_token) {
    throw new Error("Token exchange returned no access token.");
  }

  const expiresAt =
    typeof data.expires_in === "number"
      ? Date.now() + data.expires_in * 1000
      : Date.now() + CLAUDE_TOKEN_LIFETIME_SECONDS * 1000;

  return {
    type: "claude-code",
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt,
    source: "direct"
  };
}

async function refreshDirectToken(record: ClaudeCodeTokenRecord): Promise<ClaudeCodeTokenRecord> {
  if (!record.refreshToken) {
    return record;
  }

  if (typeof record.expiresAt !== "number" || Date.now() + EXPIRY_WARNING_BUFFER_MS < record.expiresAt) {
    return record;
  }

  log.info("Refreshing direct Claude Code token");

  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLAUDE_CLIENT_ID,
      refresh_token: record.refreshToken
    }),
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    log.warn({ status: response.status }, "Direct token refresh failed");
    return record;
  }

  const data = (await response.json()) as TokenExchangeResponse;
  if (!data.access_token) {
    return record;
  }

  const expiresAt =
    typeof data.expires_in === "number"
      ? Date.now() + data.expires_in * 1000
      : Date.now() + CLAUDE_TOKEN_LIFETIME_SECONDS * 1000;

  log.info({ expiresAt }, "Direct Claude Code token refreshed");

  return {
    type: "claude-code",
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : { refreshToken: record.refreshToken }),
    expiresAt,
    source: "direct"
  };
}

export async function loginClaudeCode(): Promise<ClaudeCodeTokenRecord> {
  const record = await loginClaudeCodeDirect();
  await saveClaudeCodeToken(record);
  await syncRunningGhostCredentials(record);
  return record;
}

export async function refreshClaudeCodeToken(record: ClaudeCodeTokenRecord): Promise<ClaudeCodeTokenRecord> {
  if (record.source === "keychain") {
    const refreshed = await readKeychainClaudeToken();
    return refreshed ?? record;
  }

  if (record.source === "direct") {
    return refreshDirectToken(record);
  }

  if (typeof record.expiresAt === "number" && Date.now() + EXPIRY_WARNING_BUFFER_MS >= record.expiresAt) {
    log.warn({ expiresAt: record.expiresAt }, "Claude Code setup-token is near expiry");
  }

  return record;
}

export async function writeCredentialsFile(path: string, record: ClaudeCodeTokenRecord): Promise<void> {
  const parentDirectory = dirname(path);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });

  const payload = {
    claudeAiOauth: {
      accessToken: record.accessToken,
      ...(record.refreshToken ? { refreshToken: record.refreshToken } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      scopes: [],
      subscriptionType: "max"
    }
  };

  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

const getStatePath = (): string => {
  return join(getHomeDirectory(), ".ghostbox", "state.json");
};

const getGhostCredentialsPath = (ghostName: string): string => {
  return join(getHomeDirectory(), ".ghostbox", "ghosts", ghostName, "vault", ".claude", ".credentials.json");
};

const inferAdapter = (provider: string | undefined, adapter: string | undefined): "pi" | "claude-code" => {
  if (adapter === "pi" || adapter === "claude-code") {
    return adapter;
  }

  return provider === "anthropic" ? "claude-code" : "pi";
};

type RefreshableGhostState = {
  status?: unknown;
  provider?: unknown;
  adapter?: unknown;
};

type RefreshableGhostboxState = {
  ghosts?: Record<string, RefreshableGhostState>;
};

const syncRunningGhostCredentials = async (record: ClaudeCodeTokenRecord): Promise<void> => {
  let rawState = "";

  try {
    rawState = await readFile(getStatePath(), "utf8");
  } catch {
    return;
  }

  let state: RefreshableGhostboxState;
  try {
    state = JSON.parse(rawState) as RefreshableGhostboxState;
  } catch {
    return;
  }

  const ghosts = state.ghosts ?? {};
  const syncJobs = Object.entries(ghosts)
    .filter(([, ghost]) => {
      const status = typeof ghost.status === "string" ? ghost.status : "";
      const provider = typeof ghost.provider === "string" ? ghost.provider : undefined;
      const adapter = typeof ghost.adapter === "string" ? ghost.adapter : undefined;
      return status === "running" && inferAdapter(provider, adapter) === "claude-code";
    })
    .map(async ([name]) => {
      const credentialsPath = getGhostCredentialsPath(name);
      await writeCredentialsFile(credentialsPath, record);
    });

  await Promise.all(syncJobs);
};

export function startClaudeTokenRefresher(): void {
  if (claudeTokenRefresherStarted) {
    return;
  }

  claudeTokenRefresherStarted = true;

  const tick = async (): Promise<void> => {
    try {
      const store = await readAuthTokens();
      const current = store.claudeCode;
      if (!current) {
        return;
      }

      const refreshed = await refreshClaudeCodeToken(current);
      const currentFingerprint = JSON.stringify(current);
      const refreshedFingerprint = JSON.stringify(refreshed);

      if (currentFingerprint === refreshedFingerprint) {
        return;
      }

      const nextStore: AuthTokenStore = {
        ...store,
        claudeCode: refreshed
      };

      await writeAuthTokens(nextStore);
      await syncRunningGhostCredentials(refreshed);
    } catch (error) {
      log.warn(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "Claude Code token refresh tick failed"
      );
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, CLAUDE_REFRESH_INTERVAL_MS);
}
