import { spawn as nodeSpawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { checkbox, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { loginClaudeCode, startClaudeTokenRefresher } from "./claude-auth";
import { createLogger } from "./logger";
import { getAuthStatus, loginProvider } from "./oauth";
import {
  generateApiKey,
  getConfig,
  killGhost,
  listApiKeys,
  listGhosts,
  loadState,
  mergeGhosts,
  nudgeGhost,
  removeGhost,
  revokeApiKey,
  saveState,
  sendMessage,
  spawnGhost,
  upgradeGhosts,
  wakeGhost
} from "./orchestrator";
import { clearRemoteConfig, getRemoteConfigPath, readRemoteConfig, updateRemoteConfig } from "./remote-config";
import { startBot } from "./telegram";
import type { AuthProvider, GhostApiKey, GhostboxState, GhostState } from "./types";
import { getHomeDirectory, sleep } from "./utils";
import { commitVault, pushVault } from "./vault";

const DEFAULT_IMAGE_NAME = "ghostbox-agent";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.3-codex"
};
const SUPPORTED_PROVIDERS = Object.keys(DEFAULT_MODEL_BY_PROVIDER);
const log = createLogger("cli");

type SpawnCommandOptions = {
  model?: string;
  provider?: string;
  prompt?: string;
};

const getGhostboxDirectory = (): string => join(getHomeDirectory(), ".ghostbox");

export const prompt = async (question: string): Promise<string> => {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const value = await reader.question(question);
    return value.trim();
  } finally {
    reader.close();
  }
};

const runCommandCapture = async (
  command: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => resolve({ exitCode: 1, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
};

const runCommandInherit = async (command: string, args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
      else resolve();
    });
  });
};

const requireStateDirectory = async (): Promise<void> => {
  const stateDirectory = getGhostboxDirectory();
  await mkdir(stateDirectory, { recursive: true });
};

const formatGhostTable = (ghosts: Record<string, GhostState>, currentImageVersion: string): string => {
  const header = ["NAME".padEnd(12), "MODEL".padEnd(34), "STATUS".padEnd(10), "VERSION".padEnd(28), "PORTS"].join("  ");

  const rows = Object.entries(ghosts).map(([name, ghost]) => {
    const ports = `${ghost.portBase}-${ghost.portBase + 9}`;
    const version =
      ghost.imageVersion.length === 0
        ? ""
        : ghost.imageVersion === currentImageVersion
          ? `${ghost.imageVersion} (current)`
          : `${ghost.imageVersion} (stale)`;

    return [name.padEnd(12), ghost.model.padEnd(34), ghost.status.padEnd(10), version.padEnd(28), ports].join("  ");
  });

  if (rows.length === 0) {
    return `${header}\n${"No ghosts".padEnd(12)}`;
  }

  return [header, ...rows].join("\n");
};

const formatApiKeyTable = (apiKeys: GhostApiKey[]): string => {
  const header = ["ID".padEnd(10), "LABEL".padEnd(20), "CREATED".padEnd(26), "KEY"].join("  ");

  const rows = apiKeys.map((apiKey) => {
    return [apiKey.id.padEnd(10), apiKey.label.padEnd(20), apiKey.createdAt.padEnd(26), apiKey.key].join("  ");
  });

  if (rows.length === 0) {
    return `${header}\n${"No keys".padEnd(10)}`;
  }

  return [header, ...rows].join("\n");
};

const isTelegramTokenValid = async (token: string): Promise<boolean> => {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!response.ok) return false;

    const payload = (await response.json()) as { ok?: unknown };
    return payload.ok === true;
  } catch {
    return false;
  }
};

const getRequiredInput = async (
  question: string,
  validator: (value: string) => Promise<boolean>,
  invalidMessage: string
): Promise<string> => {
  while (true) {
    const value = await prompt(question);
    if (!value.length) {
      log.warn(chalk.red("Value is required."));
      continue;
    }

    if (await validator(value)) return value;
    log.warn(chalk.red(invalidMessage));
  }
};

const isSupportedProvider = (value: string): boolean => {
  return SUPPORTED_PROVIDERS.includes(value);
};

const normalizeProvider = (value: string): string => value.trim().toLowerCase();

const getDefaultModelForProvider = (provider: string): string => {
  if (provider === "openai") {
    return DEFAULT_MODEL_BY_PROVIDER.openai;
  }

  return DEFAULT_MODEL_BY_PROVIDER.anthropic;
};

const parseProviderAndModel = (value: string): { provider: string | null; model: string } => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { provider: null, model: trimmed };
  }

  return {
    provider: normalizeProvider(trimmed.slice(0, separatorIndex)),
    model: trimmed.slice(separatorIndex + 1).trim()
  };
};

const getStoredProviderAndModel = (config: {
  defaultModel?: string;
  defaultProvider?: string | null;
}): { provider: string; model: string } => {
  const parsed = config.defaultModel ? parseProviderAndModel(config.defaultModel) : null;
  const provider = normalizeProvider(
    config.defaultProvider && config.defaultProvider.length > 0
      ? config.defaultProvider
      : (parsed?.provider ?? DEFAULT_PROVIDER)
  );

  return {
    provider: isSupportedProvider(provider) ? provider : DEFAULT_PROVIDER,
    model:
      parsed?.model && parsed.model.length > 0
        ? parsed.model
        : getDefaultModelForProvider(isSupportedProvider(provider) ? provider : DEFAULT_PROVIDER)
  };
};

// ---------- Init UI helpers ----------

type InitStepOutcome = "success" | "warning" | "failure" | "skipped";

type InitStatus = {
  label: string;
  outcome: InitStepOutcome;
  details?: string;
};

const CHECKMARK = chalk.green("*");
const CROSS = chalk.red("x");
const WARNING = chalk.yellow("!");
const SKIP = chalk.dim("-");

const stepLabel = (step: number, total: number, label: string): string => {
  return `${chalk.cyan(`[${step}/${total}]`)} ${chalk.bold(label)}`;
};

const printBanner = (): void => {
  const lines = [
    "",
    chalk.hex("#7C3AED").bold("   ________               __  __"),
    chalk.hex("#8B5CF6").bold("  / ____/ /_  ____  _____/ /_/ /_  ____  _  __"),
    chalk.hex("#A78BFA").bold(" / / __/ __ \\/ __ \\/ ___/ __/ __ \\/ __ \\| |/_/"),
    chalk.hex("#C4B5FD").bold("/ /_/ / / / / /_/ (__  ) /_/ /_/ / /_/ />  <"),
    chalk.hex("#DDD6FE").bold("\\____/_/ /_/\\____/____/\\__/_.___/\\____/_/|_|"),
    "",
    chalk.dim("  Spawn isolated AI agents in Docker containers."),
    ""
  ];
  console.log(lines.join("\n"));
};

const promptForInitAdapters = async (): Promise<AuthProvider[]> => {
  const status = await getAuthStatus();
  const anthropicAuthed = status.providers.anthropic.authenticated;
  const openaiAuthed = status.providers["openai-codex"].authenticated;

  if (anthropicAuthed && openaiAuthed) {
    console.log(`  ${CHECKMARK} All adapters already connected.`);
    return [];
  }

  if (!anthropicAuthed && !openaiAuthed) {
    console.log(chalk.yellow("  You need at least one adapter to use Ghostbox."));
  }

  const selected = await checkbox<AuthProvider>({
    message: "Select adapters to connect",
    choices: [
      {
        name: "Anthropic (Claude Pro/Max)",
        value: "anthropic" as AuthProvider,
        disabled: anthropicAuthed ? "already connected" : false
      },
      {
        name: "OpenAI (Codex)",
        value: "openai-codex" as AuthProvider,
        disabled: openaiAuthed ? "already connected" : false
      }
    ],
    theme: { prefix: chalk.hex("#7C3AED")("?") }
  });

  if (selected.length === 0 && !anthropicAuthed && !openaiAuthed) {
    console.log(chalk.red("  No adapters selected. You need at least one to use Ghostbox."));
    console.log(chalk.dim('  Run "ghostbox init" again when ready to connect an adapter.'));
    process.exit(1);
  }

  return selected;
};

const performAdapterLogin = async (provider: AuthProvider): Promise<InitStatus> => {
  const name = provider === "anthropic" ? "Anthropic" : "OpenAI";
  console.log(`  Connecting ${name}...`);

  try {
    await loginProvider(provider);
    console.log(`  ${CHECKMARK} ${name} connected`);
    return { label: name, outcome: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ${WARNING} ${name} login failed: ${chalk.yellow(message)}`);
    return { label: name, outcome: "warning", details: message };
  }
};

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json"
});

const verifyGitHubPushAccess = async (token: string, owner: string, repo: string): Promise<boolean> => {
  // Try to create a test file via the Contents API - proves write access end to end
  const testPath = ".ghostbox-write-test";
  const testContent = Buffer.from(`write test ${Date.now()}`).toString("base64");

  try {
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${testPath}`, {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify({
        message: "ghostbox: verify write access",
        content: testContent
      }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!createRes.ok) return false;

    // Clean up - delete the test file
    const created = (await createRes.json()) as { content?: { sha?: string } };
    const sha = created.content?.sha;
    if (sha) {
      await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${testPath}`, {
        method: "DELETE",
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: "ghostbox: clean up write test",
          sha
        }),
        signal: AbortSignal.timeout(10_000)
      }).catch(() => {});
    }

    return true;
  } catch {
    return false;
  }
};

const detectGhCli = async (): Promise<boolean> => {
  const check = await runCommandCapture("gh", ["auth", "status"]);
  return check.exitCode === 0;
};

const ghCliCreateRepo = async (repoName: string): Promise<{ remote: string; token: string } | null> => {
  // Create repo via gh CLI
  const create = await runCommandCapture("gh", [
    "repo",
    "create",
    repoName,
    "--private",
    "--description",
    "Ghostbox agent vaults",
    "--clone=false",
    "--confirm"
  ]);

  if (create.exitCode !== 0) {
    // Might already exist
    if (create.stderr.includes("already exists")) {
      console.log(chalk.dim(`  Repository "${repoName}" already exists, using it.`));
    } else {
      console.log(chalk.red(`  gh repo create failed: ${create.stderr.trim()}`));
      return null;
    }
  }

  // Get the authenticated user
  const whoami = await runCommandCapture("gh", ["api", "user", "--jq", ".login"]);
  const username = whoami.stdout.trim();
  if (!username) {
    console.log(chalk.red("  Could not determine GitHub username."));
    return null;
  }

  // Get a token from gh for git operations
  const tokenResult = await runCommandCapture("gh", ["auth", "token"]);
  const token = tokenResult.stdout.trim();
  if (!token) {
    console.log(chalk.red("  Could not get token from gh CLI."));
    return null;
  }

  const remote = `https://github.com/${username}/${repoName}.git`;
  return { remote, token };
};

const performGitHubSetup = async (): Promise<{
  token: string | null;
  remote: string | null;
  repoName: string | null;
}> => {
  console.log(chalk.dim("  Vaults live at ~/.ghostbox/ghosts/<name>/vault"));
  console.log(chalk.dim("  GitHub syncs vault branches for backup and portability."));
  console.log("");

  // Check if gh CLI is available and authenticated
  const hasGh = await detectGhCli();

  if (hasGh) {
    console.log(`  ${CHECKMARK} GitHub CLI detected and authenticated`);

    const useGh = await confirm({
      message: "Create a private repo for your ghost vaults?",
      default: true,
      theme: { prefix: chalk.hex("#7C3AED")("?") }
    });

    if (!useGh) {
      console.log(`  ${SKIP} GitHub skipped`);
      return { token: null, remote: null, repoName: null };
    }

    const repoNameInput = await prompt(`  Repository name [${chalk.dim("ghostbox-vault")}]: `);
    const repoName = repoNameInput.length > 0 ? repoNameInput : "ghostbox-vault";

    const result = await ghCliCreateRepo(repoName);
    if (!result) {
      return { token: null, remote: null, repoName: null };
    }

    // Verify push access
    console.log(chalk.dim("  Verifying write access..."));
    const whoami = await runCommandCapture("gh", ["api", "user", "--jq", ".login"]);
    const username = whoami.stdout.trim();
    const canPush = await verifyGitHubPushAccess(result.token, username, repoName);

    if (canPush) {
      console.log(`  ${CHECKMARK} Push access verified`);
      console.log(`  ${CHECKMARK} ${chalk.dim(result.remote)}`);
    } else {
      console.log(`  ${WARNING} Could not verify push access - you may need to check permissions`);
    }

    return { token: result.token, remote: result.remote, repoName };
  }

  // No gh CLI - fall back to manual PAT flow
  console.log(chalk.dim("  Option 1: Install GitHub CLI (gh) for automatic setup"));
  console.log(chalk.dim("            https://cli.github.com - then run: gh auth login"));
  console.log(chalk.dim('  Option 2: Create a Personal Access Token with "repo" scope'));
  console.log(chalk.dim("            https://github.com/settings/tokens/new?scopes=repo"));
  console.log("");

  const tokenInput = await prompt("  GitHub token (or Enter to skip): ");
  if (!tokenInput.length) {
    console.log(`  ${SKIP} GitHub skipped`);
    return { token: null, remote: null, repoName: null };
  }

  // Validate token
  let username: string;
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: ghHeaders(tokenInput),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(chalk.red(`  Invalid token (${response.status}): ${text.slice(0, 100)}`));
      return { token: null, remote: null, repoName: null };
    }

    // Check scopes for classic tokens
    const scopes = response.headers.get("x-oauth-scopes") ?? "";
    if (scopes && !scopes.includes("repo")) {
      console.log(chalk.yellow(`  Token scopes: ${scopes}`));
      console.log(chalk.yellow('  Warning: needs "repo" scope for push.'));
      console.log(chalk.dim("  Create one at: https://github.com/settings/tokens/new?scopes=repo"));
    }

    const user = (await response.json()) as { login?: string };
    username = user.login ?? "unknown";
    console.log(`  ${CHECKMARK} Authenticated as ${chalk.bold(username)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  GitHub auth failed: ${message}`));
    return { token: null, remote: null, repoName: null };
  }

  // Ask for repo name
  const repoNameInput = await prompt(`  Repository name [${chalk.dim("ghostbox-vault")}]: `);
  const repoName = repoNameInput.length > 0 ? repoNameInput : "ghostbox-vault";

  // Create or find repo
  let remote: string;
  try {
    const createResponse = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: ghHeaders(tokenInput),
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: "Ghostbox agent vaults",
        auto_init: true
      }),
      signal: AbortSignal.timeout(15_000)
    });

    if (createResponse.status === 422) {
      console.log(chalk.dim(`  Repository "${repoName}" already exists, using it.`));
      remote = `https://github.com/${username}/${repoName}.git`;
    } else if (!createResponse.ok) {
      const text = await createResponse.text();
      console.log(chalk.red(`  Failed to create repo (${createResponse.status}): ${text.slice(0, 100)}`));
      return { token: tokenInput, remote: null, repoName: null };
    } else {
      const repo = (await createResponse.json()) as { clone_url?: string; full_name?: string };
      remote = repo.clone_url ?? `https://github.com/${username}/${repoName}.git`;
      console.log(
        `  ${CHECKMARK} Created ${chalk.bold(repo.full_name ?? `${username}/${repoName}`)} ${chalk.dim("(private)")}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  Repo creation failed: ${message}`));
    return { token: tokenInput, remote: null, repoName: null };
  }

  // Verify push access
  console.log(chalk.dim("  Verifying write access..."));
  const canPush = await verifyGitHubPushAccess(tokenInput, username, repoName);

  if (canPush) {
    console.log(`  ${CHECKMARK} Push access verified`);
    console.log(`  ${CHECKMARK} ${chalk.dim(remote)}`);
    return { token: tokenInput, remote, repoName };
  }

  console.log(`  ${CROSS} ${chalk.red("Token does not have write access.")}`);
  console.log(chalk.dim('  Create a token with "repo" scope:'));
  console.log(chalk.dim("  https://github.com/settings/tokens/new?scopes=repo"));
  console.log("");

  const continueAnyway = await confirm({
    message: "Continue without push access?",
    default: false,
    theme: { prefix: chalk.hex("#7C3AED")("?") }
  });
  if (continueAnyway) {
    console.log(`  ${WARNING} GitHub configured without verified push access`);
    return { token: tokenInput, remote, repoName };
  }

  console.log(chalk.dim('  Update your token and run "ghostbox init" again.'));
  return { token: null, remote: null, repoName: null };
};

const performTelegramSetup = async (): Promise<string> => {
  const setup = await confirm({
    message: "Set up Telegram bot?",
    default: false,
    theme: { prefix: chalk.hex("#7C3AED")("?") }
  });

  if (!setup) {
    console.log(`  ${SKIP} Telegram skipped`);
    return "";
  }

  const token = await getRequiredInput("  Telegram bot token: ", isTelegramTokenValid, "  Invalid Telegram token.");
  console.log(`  ${CHECKMARK} Telegram bot validated`);
  return token;
};

const promptForProvider = async (defaultProvider: string): Promise<string> => {
  return select({
    message: "Default provider",
    choices: [
      { name: "Anthropic (Claude)", value: "anthropic" },
      { name: "OpenAI (Codex)", value: "openai" }
    ],
    default: defaultProvider,
    theme: { prefix: chalk.hex("#7C3AED")("?") }
  });
};

const _resolveConfiguredModel = (value: string, fallbackModel: string): string => {
  const selected = value.length > 0 ? value : fallbackModel;
  return parseProviderAndModel(selected).model;
};

const parseSpawnFlags = (
  args: string[]
): {
  name: string;
  options: SpawnCommandOptions;
} => {
  if (args.length === 0) {
    throw new Error("Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]");
  }

  const result: { name: string; options: SpawnCommandOptions } = {
    name: "",
    options: {}
  };
  let nameSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      const model = args[index + 1];
      if (!model) {
        throw new Error("Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]");
      }
      result.options.model = model;
      index += 1;
      continue;
    }

    if (arg === "--provider") {
      const provider = args[index + 1];
      if (!provider) {
        throw new Error("Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]");
      }
      result.options.provider = provider;
      index += 1;
      continue;
    }

    if (arg === "--prompt") {
      const promptText = args[index + 1];
      if (!promptText) {
        throw new Error("Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]");
      }
      result.options.prompt = promptText;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!nameSet) {
      result.name = arg;
      nameSet = true;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!nameSet) {
    throw new Error("Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]");
  }

  return result;
};

const loadExistingState = async (): Promise<GhostboxState | null> => {
  try {
    return await loadState();
  } catch {
    return null;
  }
};

const printUsage = (): void => {
  log.info(chalk.cyan("Usage:"));
  log.info("  ghostbox init                          Interactive setup wizard");
  log.info("  ghostbox login [anthropic|openai-codex|claude-code]  Login to an adapter");
  log.info("  ghostbox auth                           Show auth status");
  log.info("  ghostbox spawn <name> [--model] [--provider] [--prompt]");
  log.info("  ghostbox list                           List agents");
  log.info("  ghostbox upgrade                        Rebuild image, rolling restart");
  log.info("  ghostbox talk <name> <message>          Send message");
  log.info("  ghostbox kill <name>                    Stop agent");
  log.info("  ghostbox wake <name>                    Restart agent");
  log.info("  ghostbox save <name>                    Commit vault");
  log.info("  ghostbox merge <source> <target>        Merge vaults");
  log.info("  ghostbox logs <name>                    Tail container logs");
  log.info("  ghostbox nudge <name> [event] [reason]  Nudge agent");
  log.info("  ghostbox rm <name>                      Remove agent");
  log.info("  ghostbox keys <name>                    List API keys");
  log.info("  ghostbox keys generate <name> [label]   Create API key");
  log.info("  ghostbox keys revoke <name> <keyId>     Revoke API key");
  log.info("  ghostbox remote set <url>               Save remote API URL");
  log.info("  ghostbox remote token <token>           Save remote API token");
  log.info("  ghostbox remote status                  Show remote config");
  log.info("  ghostbox remote clear                   Clear remote config");
  log.info("  ghostbox tui                            Launch terminal UI");
  log.info("  ghostbox serve                          Start web dashboard");
  log.info("  ghostbox bot                            Start Telegram bot");
};

const API_PORT = 8008;

const findRunningPort = async (): Promise<number | null> => {
  for (let p = API_PORT; p < API_PORT + 10; p++) {
    try {
      const res = await fetch(`http://localhost:${p}/api/config`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return p;
    } catch {
      /* not listening */
    }
  }
  return null;
};

const openUrl = (url: string): void => {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (cmd) {
    const child = nodeSpawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const ensureTuiDependencies = (): void => {
  const missing = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "ink", "@inkjs/ui"].filter((pkg) => {
    try {
      require.resolve(pkg);
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `TUI dependencies are not installed: ${missing.join(", ")}. Run "bun add ink @inkjs/ui react ink-markdown" first.`
  );
};

const launchServer = async (): Promise<void> => {
  // Check if already running on any port in our range
  const existing = await findRunningPort();
  if (existing) {
    console.log(`  ${CHECKMARK} Server already running on port ${existing}`);
    const url = `http://localhost:${existing}`;
    openUrl(url);
    console.log(`  ${CHECKMARK} Dashboard: ${chalk.underline(url)}`);
    return;
  }

  // Start server - use node with the bundled api.js
  const apiProc = nodeSpawn("node", [join(__dirname, "api.js")], {
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "inherit", "inherit"]
  });

  // Wait for it to come up
  let boundPort: number | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    boundPort = await findRunningPort();
    if (boundPort) break;
  }

  if (boundPort) {
    console.log(`  ${CHECKMARK} Server running on port ${boundPort}`);
    const url = `http://localhost:${boundPort}`;
    openUrl(url);
    console.log(`  ${CHECKMARK} Dashboard: ${chalk.underline(url)}`);
    console.log("");
    console.log(chalk.dim("  Ctrl+C to stop server"));
    console.log("");

    // Keep process alive - wait for the server to exit
    await new Promise<void>((resolve) => apiProc.on("close", () => resolve()));
  } else {
    console.log(`  ${WARNING} Server may not have started. Run "ghostbox serve" manually.`);
  }
};

const init = async (forceReset = false): Promise<void> => {
  const TOTAL_STEPS = 6;
  const statuses: InitStatus[] = [];
  printBanner();

  // ---------- Fast track: everything already configured? ----------
  const existingState = await loadExistingState();
  const authBefore = await getAuthStatus();
  const hasAdapters =
    authBefore.providers.anthropic.authenticated || authBefore.providers["openai-codex"].authenticated;
  const hasConfig = existingState?.config?.defaultModel && existingState.config.defaultModel.length > 0;
  const hasImage = existingState?.config?.imageVersion && existingState.config.imageVersion.length > 0;

  if (hasAdapters && hasConfig && hasImage && !forceReset) {
    console.log(chalk.dim("  Everything is already configured."));
    console.log("");
    await launchServer();
    console.log("");
    console.log(chalk.dim("  ghostbox spawn <name>     Spawn an agent"));
    console.log(chalk.dim("  ghostbox list              List agents"));
    console.log(chalk.dim("  ghostbox init --reset      Re-run full setup"));
    console.log("");
    return;
  }

  // ---------- Step 1: Docker ----------
  console.log(stepLabel(1, TOTAL_STEPS, "Docker"));
  const dockerCheck = await runCommandCapture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (dockerCheck.exitCode !== 0) {
    console.log(`  ${CROSS} Docker is not running`);
    if (process.platform === "darwin") {
      console.log(chalk.dim("  Install Docker Desktop or OrbStack: https://orbstack.dev"));
    } else {
      console.log(chalk.dim("  Install Docker: https://docs.docker.com/engine/install/"));
    }
    statuses.push({ label: "Docker", outcome: "failure" });
    printSummary(statuses);
    process.exit(1);
  }
  const dockerVersion = dockerCheck.stdout.trim() || "available";
  console.log(`  ${CHECKMARK} Docker v${dockerVersion}`);
  statuses.push({ label: "Docker", outcome: "success" });
  console.log("");

  // ---------- Step 2: Git ----------
  const gitCheck = await runCommandCapture("git", ["--version"]);
  if (gitCheck.exitCode !== 0) {
    console.log(`  ${CROSS} Git is not installed`);
    statuses.push({ label: "Git", outcome: "failure" });
    printSummary(statuses);
    process.exit(1);
  }

  // ---------- Step 2: Adapters ----------
  console.log(stepLabel(2, TOTAL_STEPS, "Adapters"));

  // Reuse auth status from fast-track check
  const alreadyAnthropic = authBefore.providers.anthropic.authenticated;
  const alreadyOpenai = authBefore.providers["openai-codex"].authenticated;

  if (alreadyAnthropic) {
    console.log(`  ${CHECKMARK} Anthropic already connected`);
    statuses.push({ label: "Anthropic", outcome: "success" });
  }
  if (alreadyOpenai) {
    console.log(`  ${CHECKMARK} OpenAI already connected`);
    statuses.push({ label: "OpenAI", outcome: "success" });
  }

  if (!alreadyAnthropic || !alreadyOpenai) {
    const selectedAdapters = await promptForInitAdapters();

    for (const adapter of selectedAdapters) {
      const result = await performAdapterLogin(adapter);
      statuses.push(result);
    }
  }

  // Check final auth state
  const authAfterLogin = await getAuthStatus();
  const hasAnthropic = authAfterLogin.providers.anthropic.authenticated;
  const hasOpenai = authAfterLogin.providers["openai-codex"].authenticated;

  if (!hasAnthropic && !hasOpenai) {
    console.log(chalk.red("  No adapters connected. Cannot continue."));
    printSummary(statuses);
    process.exit(1);
  }

  // Determine default provider - only ask if both are available
  let defaultProvider: string;
  let defaultModel: string;

  if (hasAnthropic && hasOpenai) {
    console.log("");
    defaultProvider = await promptForProvider(DEFAULT_PROVIDER);
    defaultModel = DEFAULT_MODEL_BY_PROVIDER[defaultProvider] ?? DEFAULT_MODEL_BY_PROVIDER.anthropic;
  } else if (hasAnthropic) {
    defaultProvider = "anthropic";
    defaultModel = DEFAULT_MODEL_BY_PROVIDER.anthropic;
    console.log(`  ${CHECKMARK} Default provider: Anthropic (${defaultModel})`);
  } else {
    defaultProvider = "openai";
    defaultModel = DEFAULT_MODEL_BY_PROVIDER.openai;
    console.log(`  ${CHECKMARK} Default provider: OpenAI (${defaultModel})`);
  }
  console.log("");

  // ---------- Step 3: GitHub ----------
  console.log(stepLabel(3, TOTAL_STEPS, "GitHub"));
  const existingGh = existingState?.config?.githubToken && existingState?.config?.githubRemote;

  let githubToken: string | null;
  let githubRemote: string | null;

  if (existingGh) {
    const reuseGh = await prompt(`  Re-use existing GitHub config? [Y/n]: `);
    if (reuseGh.toLowerCase() !== "n") {
      githubToken = existingState.config.githubToken;
      githubRemote = existingState.config.githubRemote;
      console.log(`  ${CHECKMARK} GitHub: ${chalk.dim(githubRemote ?? "configured")}`);
    } else {
      const gh = await performGitHubSetup();
      githubToken = gh.token;
      githubRemote = gh.remote;
    }
  } else {
    const gh = await performGitHubSetup();
    githubToken = gh.token;
    githubRemote = gh.remote;
  }
  statuses.push({
    label: "GitHub",
    outcome: githubRemote ? "success" : githubToken ? "warning" : "skipped",
    details: githubRemote ?? undefined
  });
  console.log("");

  // ---------- Step 5: Telegram (optional) ----------
  console.log(stepLabel(4, TOTAL_STEPS, "Telegram"));

  let telegramToken: string;
  const existingTelegram = existingState?.config?.telegramToken;
  if (existingTelegram && existingTelegram.length > 0) {
    const reuseTg = await prompt(`  Re-use existing Telegram config? [Y/n]: `);
    if (reuseTg.toLowerCase() !== "n") {
      telegramToken = existingTelegram;
      console.log(`  ${CHECKMARK} Telegram: configured`);
    } else {
      telegramToken = await performTelegramSetup();
    }
  } else {
    telegramToken = await performTelegramSetup();
  }
  statuses.push({
    label: "Telegram",
    outcome: telegramToken.length > 0 ? "success" : "skipped"
  });
  console.log("");

  // ---------- Step 5: Docker image build ----------
  console.log(stepLabel(5, TOTAL_STEPS, "Docker Image"));
  console.log(chalk.dim("  Building ghostbox-agent image..."));

  await requireStateDirectory();

  // Save state before build so orchestrator can read config
  const state: GhostboxState = {
    ghosts: existingState?.ghosts ?? {},
    config: {
      githubRemote,
      githubToken,
      telegramToken,
      defaultProvider,
      defaultModel,
      imageName: existingState?.config?.imageName ?? DEFAULT_IMAGE_NAME,
      imageVersion: existingState?.config?.imageVersion ?? "",
      observerModel: existingState?.config?.observerModel ?? ""
    },
    telegram: existingState?.telegram ?? { activeChatGhosts: {} }
  };
  await saveState(state);

  try {
    // docker/ ships pre-built with ghost-server.js inside the package
    const dockerDir = join(__dirname, "..", "docker");
    await runCommandInherit("docker", ["build", "-t", DEFAULT_IMAGE_NAME, dockerDir]);

    const { computeImageVersion } = await import("./orchestrator");
    const imageVersion = computeImageVersion(dockerDir);
    const refreshedState = await loadState();
    refreshedState.config.imageVersion = imageVersion;
    await saveState(refreshedState);

    console.log(`  ${CHECKMARK} Image built ${chalk.dim(`(${imageVersion})`)}`);
    statuses.push({ label: "Docker Image", outcome: "success" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ${CROSS} Image build failed: ${message}`);
    statuses.push({ label: "Docker Image", outcome: "failure", details: message });
  }
  console.log("");

  // ---------- Step 6: Launch ----------
  console.log(stepLabel(6, TOTAL_STEPS, "Launch"));

  try {
    await launchServer();
    statuses.push({ label: "Launch", outcome: "success" });
  } catch {
    console.log(`  ${WARNING} Could not start server automatically.`);
    statuses.push({ label: "Launch", outcome: "warning" });
  }
  console.log("");

  // ---------- Summary ----------
  printSummary(statuses);

  console.log("");
  console.log(chalk.dim("  Next steps:"));
  console.log(chalk.dim("    ghostbox spawn <name>     Spawn an agent"));
  console.log(chalk.dim("    ghostbox list              List agents"));
  if (telegramToken.length > 0) {
    console.log(chalk.dim("    ghostbox bot               Start Telegram bot"));
  }
  console.log("");
};

const printSummary = (statuses: InitStatus[]): void => {
  const maxLabelLen = Math.max(...statuses.map((s) => s.label.length), 10);

  console.log(chalk.bold("  Setup Summary"));
  console.log(chalk.dim(`  ${"-".repeat(maxLabelLen + 16)}`));

  for (const s of statuses) {
    let icon: string;
    let detail = "";
    switch (s.outcome) {
      case "success":
        icon = CHECKMARK;
        break;
      case "warning":
        icon = WARNING;
        detail = s.details ? chalk.yellow(` (${s.details})`) : "";
        break;
      case "failure":
        icon = CROSS;
        detail = s.details ? chalk.red(` (${s.details})`) : "";
        break;
      case "skipped":
        icon = SKIP;
        detail = chalk.dim(" skipped");
        break;
    }

    console.log(`  ${icon} ${s.label.padEnd(maxLabelLen)}${detail}`);
  }
};

const spawn = async (name: string, options: SpawnCommandOptions): Promise<void> => {
  const state = await loadState();
  const config = state.config as GhostboxState["config"] & { defaultProvider?: string | null };
  const storedDefaults = getStoredProviderAndModel({
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider ?? null
  });
  const parsedModel = options.model
    ? parseProviderAndModel(options.model)
    : { provider: null, model: storedDefaults.model };
  const defaultProvider = storedDefaults.provider;
  const providerInput = options.provider ? normalizeProvider(options.provider) : null;

  if (parsedModel.provider && providerInput && parsedModel.provider !== providerInput) {
    throw new Error(`Provider mismatch: model uses "${parsedModel.provider}" but --provider was "${providerInput}".`);
  }

  const provider = parsedModel.provider ?? providerInput ?? defaultProvider;
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  if (!parsedModel.model) {
    throw new Error("Model is required.");
  }

  await spawnGhost(name, provider, parsedModel.model, options.prompt);
  const updatedState = await loadState();
  const ghost = updatedState.ghosts[name];
  if (!ghost) throw new Error(`Failed to load ghost "${name}" after spawn.`);

  const range = `${ghost.portBase}-${ghost.portBase + 9}`;
  log.info(chalk.green(`Ghost ${name} is alive on ports ${range}`));
};

const list = async (): Promise<void> => {
  const ghosts = await listGhosts();
  const config = await getConfig();
  log.info(formatGhostTable(ghosts, config.imageVersion));
};

const upgrade = async (): Promise<void> => {
  const state = await loadState();
  const imageName = state.config.imageName || DEFAULT_IMAGE_NAME;
  const dockerDir = join(__dirname, "..", "docker");

  await runCommandInherit("docker", ["build", "-t", imageName, dockerDir]);

  const result = await upgradeGhosts(dockerDir);
  log.info(`Upgraded: ${result.upgraded.length}, Skipped: ${result.skipped.length}, Failed: ${result.failed.length}`);
};

const keys = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    throw new Error(
      "Usage: ghostbox keys <name> | ghostbox keys generate <name> [label] | ghostbox keys revoke <name> <keyId>"
    );
  }

  if (args[0] === "generate") {
    const name = args[1];
    const label = args[2] ?? "default";

    if (!name) {
      throw new Error("Usage: ghostbox keys generate <name> [label]");
    }

    const apiKey = await generateApiKey(name, label);
    log.info(chalk.green(`Created API key ${apiKey.id} for ${name}.`));
    log.info(`Label: ${apiKey.label}`);
    log.info(`Key: ${apiKey.key}`);
    log.warn(chalk.yellow("Save this key - it will not be shown again"));
    return;
  }

  if (args[0] === "revoke") {
    const name = args[1];
    const keyId = args[2];

    if (!name || !keyId) {
      throw new Error("Usage: ghostbox keys revoke <name> <keyId>");
    }

    await revokeApiKey(name, keyId);
    log.info(chalk.green(`Revoked API key ${keyId} for ${name}.`));
    return;
  }

  if (args.length > 1) {
    throw new Error("Usage: ghostbox keys <name>");
  }

  const apiKeys = await listApiKeys(args[0]);
  log.info(formatApiKeyTable(apiKeys));
};

const talk = async (name: string, message: string): Promise<void> => {
  const messages = sendMessage(name, message);
  for await (const item of messages) {
    if (item.type === "assistant") {
      process.stdout.write(`${item.text}\n`);
      continue;
    }
    if (item.type === "tool_use") {
      process.stdout.write(`[tool] ${item.tool}\n`);
      continue;
    }
    if (item.type === "result") {
      process.stdout.write(`${item.text}\n`);
    }
  }
};

const save = async (name: string): Promise<void> => {
  const state = await loadState();
  const commitHash = await commitVault(name);
  if (state.config.githubRemote && state.config.githubToken) {
    await pushVault(name, state.config.githubRemote, state.config.githubToken);
  }

  if (!commitHash) {
    log.warn(chalk.yellow(`No changes for ${name}.`));
    return;
  }

  log.info(chalk.green(`Saved ${name} at ${commitHash}`));
};

const merge = async (source: string, target: string): Promise<void> => {
  const result = await mergeGhosts(source, target);
  log.info(chalk.green("Merge result:"));
  log.info(result);
};

const logs = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = state.ghosts[name];
  if (!ghost) {
    throw new Error(`Ghost "${name}" not found.`);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = nodeSpawn("docker", ["logs", "-f", ghost.containerId], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`docker logs failed with exit code ${exitCode}`);
  }
};

const remote = async (args: string[]): Promise<void> => {
  const subcommand = args[0];

  switch (subcommand) {
    case "set": {
      const url = args[1]?.trim();
      if (!url || args.length !== 2) {
        throw new Error("Usage: ghostbox remote set <url>");
      }

      const config = await updateRemoteConfig({ url });
      log.info(chalk.green(`Saved remote URL to ${getRemoteConfigPath()}.`));
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "token": {
      const token = args[1]?.trim();
      if (!token || args.length !== 2) {
        throw new Error("Usage: ghostbox remote token <token>");
      }

      const config = await updateRemoteConfig({ token });
      log.info(chalk.green(`Saved remote token to ${getRemoteConfigPath()}.`));
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "status": {
      if (args.length !== 1) {
        throw new Error("Usage: ghostbox remote status");
      }

      const config = await readRemoteConfig();
      if (!config) {
        log.info("No remote config found.");
        return;
      }

      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "clear": {
      if (args.length !== 1) {
        throw new Error("Usage: ghostbox remote clear");
      }

      await clearRemoteConfig();
      log.info(chalk.green(`Cleared remote config at ${getRemoteConfigPath()}.`));
      return;
    }
    default:
      throw new Error("Usage: ghostbox remote <set <url>|token <token>|status|clear>");
  }
};

const bot = async (): Promise<void> => {
  const state = await loadState();
  log.info("Running bot pre-flight checks");
  startClaudeTokenRefresher();

  const dockerCheck = await runCommandCapture("docker", ["info"]);
  if (dockerCheck.exitCode !== 0) {
    log.error(
      {
        stdout: dockerCheck.stdout.trim(),
        stderr: dockerCheck.stderr.trim()
      },
      "Docker is not reachable"
    );
    throw new Error("Docker is not available.");
  }
  log.info("Docker is reachable");

  const isTokenValid = await isTelegramTokenValid(state.config.telegramToken);
  if (!isTokenValid) {
    log.error("Telegram token is invalid");
    throw new Error("Invalid Telegram token.");
  }
  log.info("Telegram token is valid");

  log.info("Starting Ghostbox bot...");
  await startBot(state.config.telegramToken);
};

const main = async (): Promise<void> => {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case "init":
        await init(args.includes("--reset"));
        break;
      case "login": {
        const provider = args[0];
        if (!provider || !["anthropic", "openai-codex", "claude-code"].includes(provider)) {
          throw new Error("Usage: ghostbox login [anthropic|openai-codex|claude-code]");
        }

        if (provider === "claude-code") {
          await loginClaudeCode();
          log.info(chalk.green("Claude Code connected."));
          break;
        }

        await loginProvider(provider as AuthProvider);
        log.info(chalk.green(`${provider === "anthropic" ? "Anthropic" : "OpenAI"} connected.`));
        break;
      }
      case "auth": {
        const authStatus = await getAuthStatus();
        const format = args[0] === "--json";
        if (format) {
          console.log(JSON.stringify(authStatus, null, 2));
        } else {
          for (const [id, status] of Object.entries(authStatus.providers)) {
            const name = id === "anthropic" ? "Anthropic" : "OpenAI";
            if (status.authenticated) {
              const expires = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "unknown";
              log.info(chalk.green(`${name}: connected (expires ${expires})`));
            } else {
              log.info(chalk.dim(`${name}: not connected`));
            }
          }

          if (authStatus.claudeCode.authenticated) {
            const expires = authStatus.claudeCode.expiresAt
              ? new Date(authStatus.claudeCode.expiresAt).toLocaleString()
              : "unknown";
            log.info(chalk.green(`Claude Code: connected (expires ${expires})`));
          } else {
            log.info(chalk.dim("Claude Code: not connected"));
          }
        }
        break;
      }
      case "spawn": {
        const parsed = parseSpawnFlags(args);
        await spawn(parsed.name, parsed.options);
        break;
      }
      case "list":
        await list();
        break;
      case "upgrade":
        await upgrade();
        break;
      case "talk": {
        const [name, ...messageParts] = args;
        if (!name || messageParts.length === 0) {
          throw new Error("Usage: ghostbox talk <name> <message>");
        }
        await talk(name, messageParts.join(" "));
        break;
      }
      case "kill":
        if (!args[0]) {
          throw new Error("Usage: ghostbox kill <name>");
        }
        await killGhost(args[0]);
        log.info(chalk.green(`Killed ${args[0]}`));
        break;
      case "wake":
        if (!args[0]) {
          throw new Error("Usage: ghostbox wake <name>");
        }
        await wakeGhost(args[0]);
        log.info(chalk.green(`Woke ${args[0]}`));
        break;
      case "save":
        if (!args[0]) {
          throw new Error("Usage: ghostbox save <name>");
        }
        await save(args[0]);
        break;
      case "merge":
        if (!args[0] || !args[1]) {
          throw new Error("Usage: ghostbox merge <source> <target>");
        }
        await merge(args[0], args[1]);
        break;
      case "logs":
        if (!args[0]) {
          throw new Error("Usage: ghostbox logs <name>");
        }
        await logs(args[0]);
        break;
      case "nudge": {
        if (!args[0]) {
          throw new Error("Usage: ghostbox nudge <name> [event] [reason]");
        }
        const nudgeEvent = args[1] || "self";
        const nudgeReason = args[2] || "cli";
        await nudgeGhost(args[0], nudgeEvent, nudgeReason);
        log.info(chalk.green(`Nudged ${args[0]} (${nudgeEvent}: ${nudgeReason})`));
        break;
      }
      case "rm":
        if (!args[0]) {
          throw new Error("Usage: ghostbox rm <name>");
        }
        await removeGhost(args[0]);
        log.info(chalk.green(`Removed ${args[0]}`));
        break;
      case "keys":
        await keys(args);
        break;
      case "remote":
        await remote(args);
        break;
      case "serve":
        await launchServer();
        break;
      case "tui": {
        ensureTuiDependencies();
        await runCommandInherit("bun", ["run", "src/tui/index.tsx"]);
        break;
      }
      case "bot":
        await bot();
        break;
      default:
        printUsage();
        process.exitCode = 1;
        return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error occurred.";
    log.error(chalk.red(message));
    process.exitCode = 1;
    return;
  }

  if (command === "bot") {
    return;
  }
};

main();
