import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./logger";
import { readAuthTokens, writeAuthTokens } from "./oauth";
import type { AuthTokenStore, ClaudeCodeTokenRecord } from "./types";

const SETUP_TOKEN_PATTERN = /sk-ant-[^\s"'`]+/g;
const EXPIRY_WARNING_BUFFER_MS = 5 * 60 * 1000;
const log = createLogger("claude-auth");

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

export async function readKeychainClaudeToken(): Promise<ClaudeCodeTokenRecord | null> {
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

export async function runSetupToken(): Promise<ClaudeCodeTokenRecord> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("claude", ["setup-token"], {
      stdio: ["inherit", "pipe", "inherit"]
    });

    let stdout = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude setup-token failed with exit code ${code ?? 1}.`));
        return;
      }

      const matches = stdout.match(SETUP_TOKEN_PATTERN);
      const accessToken = matches?.at(-1);
      if (!accessToken) {
        reject(new Error("claude setup-token did not print a Claude Code token."));
        return;
      }

      resolve({
        type: "claude-code",
        accessToken,
        source: "setup-token"
      });
    });
  });
}

export async function loginClaudeCode(): Promise<ClaudeCodeTokenRecord> {
  const keychainRecord = await readKeychainClaudeToken();
  const record = keychainRecord ?? (await runSetupToken());
  await saveClaudeCodeToken(record);
  return record;
}

export async function refreshClaudeCodeToken(record: ClaudeCodeTokenRecord): Promise<ClaudeCodeTokenRecord> {
  if (record.source === "keychain") {
    const refreshed = await readKeychainClaudeToken();
    return refreshed ?? record;
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
}
