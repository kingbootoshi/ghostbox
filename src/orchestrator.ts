import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { refreshClaudeCodeToken, writeCredentialsFile } from "./claude-auth";
import { createLogger } from "./logger";
import { readClaudeCodeToken } from "./oauth";
import { publishGhostRemoveEvent, publishGhostUpsertEvent, publishMessageCompletedEvent } from "./realtime-events";
import type {
  AdapterType,
  GhostApiKey,
  GhostboxConfig,
  GhostboxState,
  GhostImage,
  GhostMessage,
  GhostQueueClearResponse,
  GhostQueueEnqueueResponse,
  GhostQueueState,
  GhostRuntimeCapability,
  GhostRuntimeMeta,
  GhostState,
  GhostStreamingBehavior,
  SessionListResponse,
  TimelineResponse
} from "./types";
import { getHomeDirectory, isNodeError, sleep } from "./utils";
import { commitVault, getVaultPath, initVault, mergeVaults } from "./vault";

const defaultImageName = "ghostbox-agent";
const defaultProvider = "anthropic";

type HistoryRequestOptions = {
  limit?: number;
  cursor?: string;
};

const getGhostPiAgentPath = (name: string): string => join(getHomeDirectory(), ".ghostbox", "ghosts", name, "pi-agent");
const getGhostClaudeConfigPath = (name: string): string => join(getVaultPath(name), ".claude");
const getSharedPiAgentPath = (): string => join(getHomeDirectory(), ".pi", "agent");
const getBasePath = (): string => join(getHomeDirectory(), ".ghostbox", "base");
const getBaseExtensionsPath = (): string => join(getBasePath(), "extensions");
const getBaseAgentsPath = (): string => join(getBasePath(), "AGENTS.md");
const getBundledBaseExtensionsPath = (): string => fileURLToPath(new URL("../base/extensions", import.meta.url));

export const computeImageVersion = (dockerDir: string): string => {
  // Accept both absolute and relative paths
  const resolvedDockerDir = dockerDir.startsWith("/") ? dockerDir : join(process.cwd(), dockerDir);
  const files = [
    "ghost-server.js",
    "ghost-server-claude.js",
    "ghostbox-mcp-server.js",
    "Dockerfile",
    "entrypoint.sh",
    "ghost-changelog",
    "ghost-nudge",
    "qmd",
    "ghost-save",
    "exa-search",
    "skills/ghostbox-api/SKILL.md"
  ];
  const contents = files.map((file) => readFileSync(join(resolvedDockerDir, file), "utf8")).join("");
  const hash = createHash("sha256").update(contents).digest("hex");

  return `gb-${hash.slice(0, 8)}`;
};

const baseAgentsContent = `# Ghostbox Agent Core

You are a persistent agent. Your vault at /vault is your brain on disk. You have two memory layers and must actively use both.

## Memory

### Warm Memory (MEMORY.md + USER.md - injected into your prompt)

Two files are loaded into your system prompt at session start:
- **MEMORY.md** - Your personal notes. Environment facts, project conventions, tool quirks, file references, lessons learned. Anything you want to remember.
- **USER.md** - Who the user is. Name, role, preferences, communication style, corrections, pet peeves.

These are your "working memory" - what you immediately know without searching. Keep them compact and high-signal. Entries are separated by a line containing only \`§\`.

**Tools: memory_write, memory_replace, memory_remove, memory_show** (native tools - use directly, no bash needed)

- \`memory_write\` - Add an entry. Params: target ("memory" or "user"), content (the text).
- \`memory_replace\` - Replace an entry by substring match. Params: target, search (substring to find), content (replacement).
- \`memory_remove\` - Remove an entry by substring match. Params: target, search (substring to find).
- \`memory_show\` - Show current memory contents and usage stats. Params: target (optional, omit for both).

Limits: MEMORY.md 4000 chars, USER.md 2000 chars. If full, replace or remove entries first.

Write whatever you want. No schema, no categories. Your thoughts in your words.

**Priority**: User corrections and preferences > environment facts > conventions > file references.
The most valuable memory prevents the user from having to repeat themselves.

## Change Log

Track meaningful work in \`/vault/CHANGELOG.md\`. Use this after completing significant work so there is a simple record of what changed and why.

**CLI: ghost-changelog**
\`\`\`
ghost-changelog add "Fixed order validation bug" --tag BUG-2847
ghost-changelog add "Created codebase-search extension" --tag extension
ghost-changelog add "Upgraded auth middleware" --tag security
ghost-changelog list
ghost-changelog list 5
\`\`\`

### Deep Memory (vault files - searched on demand)

Your vault holds detailed knowledge: research notes, code, runbooks. Use \`qmd\` to find and read them.

**CLI: qmd**
\`\`\`
qmd search "query"                        # ripgrep through vault files
qmd search "query" --type md              # Search only markdown
qmd read <path>                           # Read a vault file
qmd read <path> --section "heading"       # Read a specific section
qmd list [pattern]                        # List vault files (glob)
qmd tree [depth]                          # Directory structure
qmd recent [N]                            # Recently modified files
qmd headings <path>                       # Show headings in a file
qmd summary                               # Quick vault overview
\`\`\`

### How They Work Together

Warm memory is your **map**. Deep memory is the **territory**.

MEMORY.md tells you what you know and where to find it:
\`\`\`
API rate limiting notes in knowledge/api-limits.md
§
The deploy script needs --no-cache flag or builds stale
§
User's project uses PostgreSQL 16 with pgvector
\`\`\`

When you need the full rate limiting details, you run \`qmd read knowledge/api-limits.md\`.

The workflow:
1. Your warm memory is already in your prompt - check it first
2. If it points to a file, use \`qmd read\` to get the details
3. If you need to find something not in memory, use \`qmd search\`
4. After learning something new: save a note to warm memory, write details to a vault file

### When to Save (Proactively)

You are responsible for memory. There is no background process that will reliably save things for you later.
If something matters and you do not save it, it can be lost.
Before compaction, you will get one final turn to save. But do not rely on this - save continuously as you learn.

Save when you learn:

**ALWAYS save immediately:**
- User corrects you -> update memory or user profile NOW
- User states a preference -> save to user profile NOW
- You discover environment facts (OS, tools, paths, configs) -> save to memory
- You discover project conventions (coding style, build process, deploy flow) -> save to memory
- You complete significant work -> save what changed and what you learned
- You create/update vault files -> add a reference in MEMORY.md so future sessions find them

**Never save:**
- Task progress or temporary state (ephemeral)
- Things easily re-discovered (common API docs, language features)
- Raw data dumps (summarize instead)
- Session-specific debugging context

**Memory hygiene:**
- When memory is wrong: replace or remove it immediately
- When memory is full (>80%): consolidate related entries before adding new ones
- Keep entries dense and specific, not vague

### Memory Discipline

**Before responding to complex questions:** check memory, search vault, THEN answer.

**Proactive research protocol (especially for engineering tasks):**
1. Check warm memory for relevant context
2. \`qmd search\` the vault for related notes
3. \`exa-search\` for current external information if needed
4. Then respond with actual context - never guess at APIs, configs, or patterns

## Vault Structure

\`\`\`
/vault/
  CLAUDE.md             # Your identity and learned instructions
  MEMORY.md             # Warm memory (injected into prompt each session)
  USER.md               # User profile (injected into prompt each session)
  knowledge/            # Detailed notes, research, findings
  code/                 # Projects, scripts, tools
  .pi/extensions/       # Pi agent extensions (self-evolution)
\`\`\`

## Tools

**Native (use directly):**
- \`memory_write\` - Add entry to warm memory (MEMORY.md or USER.md)
- \`memory_replace\` - Replace entry by substring match
- \`memory_remove\` - Remove entry by substring match
- \`memory_show\` - Show memory contents and usage
- \`web_search\` / \`code_search\` - Exa search (via base extension)

**Background execution (base extension):**
- \`background_bash\` - Run a command in the background without blocking. Params: command (string), label (optional string). Returns a task ID immediately. When the command finishes, its output is sent to your next turn automatically.
- \`background_status\` - List running and completed background tasks.

**Prefer background_bash over bash for:**
- Polling loops (curl retries with sleep)
- Long downloads or uploads
- Dev servers and watchers
- Any command that will take more than 10 seconds
- Anything you would otherwise run in a bash while-loop

Regular bash blocks your conversation. background_bash lets you keep working while the command runs.

**Bash CLI:**
- \`ghost-changelog add "description" --tag TAG\` - Log what you changed and why
- \`ghost-nudge memory\` - Trigger manual memory-review fallback
- \`ghost-nudge self "reason"\` - Schedule a self-nudge
- \`qmd\` - Search and read vault files
- \`ghost-save "message"\` - Commit and push vault to GitHub
- \`exa-search "query"\` - Web search (alternative to web_search tool)
- \`exa-search --code "query"\` - Code search (alternative to code_search tool)

## When to Save (ghost-save)

**Run ghost-save after:**
- Creating or updating extensions
- Completing a bug fix or feature dispatch
- Writing knowledge docs or architecture notes
- Any work you'd want to survive a container rebuild

Format: \`ghost-save "Brief description of what changed"\`
This commits your entire vault and pushes to GitHub on your branch (ghost/YOUR_NAME).

## Slash Commands

- \`/reload\` - Reload extensions from /vault/.pi/extensions/. Use after creating or editing extension files to activate them.

## Self-Evolution

Write TypeScript extensions to /vault/.pi/extensions/. They persist in your vault, load on startup, and compound over sessions. Base extensions in /root/.pi/agent/extensions/ are read-only.

**Extension workflow:**
1. Write your .ts file to /vault/.pi/extensions/
2. Run /reload to activate it
3. Test the tool in conversation
4. Run ghost-changelog add "Created X extension" --tag extension
5. Run ghost-save "Add X extension" to push to GitHub
`;

const ensureGhostPiAgent = async (name: string): Promise<void> => {
  const ghostPiPath = getGhostPiAgentPath(name);
  await mkdir(ghostPiPath, { recursive: true });

  const sharedPath = getSharedPiAgentPath();
  await mkdir(sharedPath, { recursive: true });
  const settingsSource = join(sharedPath, "settings.json");
  const settingsDest = join(ghostPiPath, "settings.json");
  if (existsSync(settingsSource) && !existsSync(settingsDest)) {
    await copyFile(settingsSource, settingsDest);
  }

  const baseAgentsSource = getBaseAgentsPath();
  const agentsDest = join(ghostPiPath, "AGENTS.md");
  if (existsSync(baseAgentsSource)) {
    await copyFile(baseAgentsSource, agentsDest);
  }
};

const writeFileIfMissing = async (path: string, content: string): Promise<void> => {
  if (!existsSync(path)) {
    await writeFile(path, content);
  }
};

const syncBundledBaseExtensions = async (destinationPath: string): Promise<void> => {
  const sourcePath = getBundledBaseExtensionsPath();
  if (!existsSync(sourcePath)) {
    return;
  }

  const entries = await readdir(sourcePath, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => copyFile(join(sourcePath, entry.name), join(destinationPath, entry.name)))
  );
};

const ensureBaseExtensions = async (): Promise<void> => {
  const basePath = getBasePath();
  const baseExtensionsPath = getBaseExtensionsPath();

  await mkdir(basePath, { recursive: true });
  await mkdir(baseExtensionsPath, { recursive: true });

  await writeFileIfMissing(getBaseAgentsPath(), baseAgentsContent);
  await syncBundledBaseExtensions(baseExtensionsPath);
};

const log = createLogger("orchestrator");

const docker = new Docker();

const createGhostApiKey = (label: string): GhostApiKey => {
  return {
    id: randomBytes(4).toString("hex"),
    key: `gbox_${randomBytes(16).toString("hex")}`,
    label,
    createdAt: new Date().toISOString()
  };
};

const maskGhostApiKey = (key: string): string => {
  return `gbox_****${key.slice(-4)}`;
};

const getGhostApiKeyValues = (ghost: GhostState): string[] => {
  return ghost.apiKeys.map((apiKey) => apiKey.key);
};

const getGhostboxApiKeysEnv = (ghost: GhostState): string => {
  return `GHOSTBOX_API_KEYS=${JSON.stringify(getGhostApiKeyValues(ghost))}`;
};

const getGhostboxApiPortEnv = (): string => {
  return `GHOSTBOX_API_PORT=${process.env.GHOSTBOX_API_PORT || "8008"}`;
};

const getGhostNudgeKeyEnv = (ghost: GhostState): string => {
  const firstKey = ghost.apiKeys[0]?.key ?? "";
  return `GHOST_API_KEY=${firstKey}`;
};

const getGhostAuthorizationHeader = (ghost: GhostState): string | null => {
  const apiKey = ghost.apiKeys[0];
  return apiKey ? `Bearer ${apiKey.key}` : null;
};

const getGhostAuthHeaders = (ghost: GhostState): Record<string, string> => {
  return getGhostAuthorizationHeader(ghost) ? { Authorization: getGhostAuthorizationHeader(ghost) as string } : {};
};

const inferAdapterFromProvider = (provider: string): AdapterType => {
  return provider === "anthropic" ? "claude-code" : "pi";
};

const writeClaudeMcpConfig = async (path: string): Promise<void> => {
  const payload = {
    mcpServers: {
      ghostbox: {
        command: "node",
        args: ["/ghostbox-mcp-server.js"]
      },
      exa: {
        type: "http",
        url: "https://mcp.exa.ai/mcp"
      },
      qmd: {
        command: "node",
        args: ["/qmd-mcp-server.js"]
      }
    }
  };

  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
};

const ensureClaudeCodeRuntimeFiles = async (name: string): Promise<string> => {
  const record = await readClaudeCodeToken();
  if (!record) {
    throw new Error("Run ghostbox login claude-code first.");
  }

  const refreshed = await refreshClaudeCodeToken(record);
  const claudeConfigPath = getGhostClaudeConfigPath(name);
  await mkdir(claudeConfigPath, { recursive: true, mode: 0o700 });
  await writeCredentialsFile(join(claudeConfigPath, ".credentials.json"), refreshed);
  await writeClaudeMcpConfig(join(claudeConfigPath, ".mcp.json"));
  return refreshed.accessToken;
};

const normalizeGhostState = (
  ghost: GhostState | (Omit<GhostState, "apiKeys"> & { apiKeys?: GhostApiKey[] })
): GhostState => {
  return {
    ...ghost,
    adapter: ghost.adapter ?? inferAdapterFromProvider(ghost.provider),
    imageVersion: ghost.imageVersion || "",
    apiKeys: Array.isArray(ghost.apiKeys) ? ghost.apiKeys : []
  };
};

const normalizeState = (state: GhostboxState): GhostboxState => {
  return {
    ...state,
    config: {
      ...state.config,
      imageVersion: state.config.imageVersion || ""
    },
    ghosts: Object.fromEntries(Object.entries(state.ghosts).map(([name, ghost]) => [name, normalizeGhostState(ghost)]))
  };
};

const isDockerConnectionIssue = (error: unknown): boolean => {
  if (!isNodeError(error) || typeof error.code !== "string") {
    return false;
  }

  return ["ENOENT", "ECONNREFUSED", "EACCES", "ENOTFOUND", "EPIPE", "ECONNRESET", "ETIMEDOUT"].includes(error.code);
};

const logDockerConnectionIssue = (error: unknown, context: { name: string; operation: string }): void => {
  if (isDockerConnectionIssue(error)) {
    log.error({ err: error, ...context }, "Docker connection issue");
  }
};

const loadStateFile = async (path: string): Promise<GhostboxState> => {
  try {
    const { readFile } = await import("node:fs/promises");
    const contents = await readFile(path, "utf8");
    return normalizeState(JSON.parse(contents) as GhostboxState);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`State file not found at ${path}. Run ghostbox init to create it first.`);
    }
    throw error;
  }
};

const parseGhostMessage = (line: string): GhostMessage => {
  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error("Invalid ghost message");
  }

  const record = parsed as Record<string, unknown>;
  const type = record.type;

  if (type === "assistant") {
    if (typeof record.text !== "string") throw new Error("Invalid assistant message");
    return { type: "assistant", text: record.text };
  }

  if (type === "thinking") {
    if (typeof record.text !== "string") throw new Error("Invalid thinking message");
    return { type: "thinking", text: record.text };
  }

  if (type === "tool_use") {
    if (typeof record.tool !== "string") throw new Error("Invalid tool_use message");
    return { type: "tool_use", tool: record.tool, input: record.input ?? null };
  }

  if (type === "tool_result") {
    return { type: "tool_result", output: record.output ?? null };
  }

  if (type === "result") {
    if (typeof record.text !== "string" || typeof record.sessionId !== "string") {
      throw new Error("Invalid result message");
    }
    return {
      type: "result",
      text: record.text,
      sessionId: record.sessionId
    };
  }

  if (type === "heartbeat") {
    return { type: "heartbeat" };
  }

  throw new Error(`Unknown message type: ${type}`);
};

const getGhostFromState = (state: GhostboxState, name: string): GhostState => {
  const ghost = state.ghosts[name];
  if (!ghost) {
    throw new Error(`Ghost "${name}" not found.`);
  }
  return ghost;
};

const buildPortBindings = (portBase: number): Record<string, [{ HostPort: string }]> => {
  const ports: Record<string, [{ HostPort: string }]> = {
    "3000/tcp": [{ HostPort: String(portBase) }]
  };

  for (let index = 1; index <= 9; index++) {
    ports[`${8000 + index}/tcp`] = [{ HostPort: String(portBase + index) }];
  }

  return ports;
};

const buildExposedPorts = (): Record<string, Record<string, never>> => {
  const ports: Record<string, Record<string, never>> = {
    "3000/tcp": {}
  };

  for (let index = 1; index <= 9; index++) {
    ports[`${8000 + index}/tcp`] = {};
  }

  return ports;
};

const resolveProviderModel = (
  provider: string | null | undefined,
  model: string,
  fallbackProvider = defaultProvider
): { provider: string; model: string; fullModel: string } => {
  const separatorIndex = model.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < model.length - 1) {
    return {
      provider: model.slice(0, separatorIndex),
      model: model.slice(separatorIndex + 1),
      fullModel: model
    };
  }

  const resolvedProvider = typeof provider === "string" && provider.length > 0 ? provider : fallbackProvider;

  return {
    provider: resolvedProvider,
    model,
    fullModel: `${resolvedProvider}/${model}`
  };
};

const waitForHealth = async (name: string, port: number): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    log.debug({ name, attempt: attempt + 1 }, "Health check");
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return;
    } catch {
      // continue retry
    }

    await sleep(1000);
  }

  throw new Error(`Ghost did not become healthy on port ${port}`);
};

const startGhostContainer = async (
  state: GhostboxState,
  name: string,
  ghost: GhostState,
  fullModel: string,
  systemPrompt: string | null | undefined,
  operation: string
): Promise<string> => {
  const vaultPath = getVaultPath(name);
  const piAgentPath = getGhostPiAgentPath(name);
  const baseExtensionsPath = getBaseExtensionsPath();
  const sharedAuthPath = join(getSharedPiAgentPath(), "auth.json");
  const binds = [
    `${vaultPath}:/vault`,
    `${piAgentPath}:/root/.pi/agent`,
    `${baseExtensionsPath}:/root/.pi/agent/extensions:ro`
  ];

  if (ghost.adapter !== "claude-code" && existsSync(sharedAuthPath)) {
    binds.push(`${sharedAuthPath}:/root/.pi/agent/auth.json:rw`);
  }

  const adapter = ghost.adapter ?? inferAdapterFromProvider(ghost.provider);
  const env = [
    `GHOSTBOX_MODEL=${fullModel}`,
    `GHOSTBOX_IMAGE_VERSION=${state.config.imageVersion || ghost.imageVersion || ""}`,
    `GHOSTBOX_SYSTEM_PROMPT=${systemPrompt || ""}`,
    `GHOSTBOX_GHOST_NAME=${name}`,
    `GHOSTBOX_GITHUB_TOKEN=${state.config.githubToken || ""}`,
    `GHOSTBOX_GITHUB_REMOTE=${state.config.githubRemote || ""}`,
    `GHOSTBOX_HOST_BASE_PORT=${ghost.portBase}`,
    getGhostboxApiPortEnv(),
    `GHOSTBOX_USER_PORTS=8001-8009`,
    `GHOSTBOX_OBSERVER_MODEL=${state.config.observerModel || ""}`,
    getGhostboxApiKeysEnv(ghost),
    getGhostNudgeKeyEnv(ghost),
    `GHOSTBOX_ADAPTER=${adapter}`
  ];

  if (adapter === "claude-code") {
    const claudeToken = await ensureClaudeCodeRuntimeFiles(name);
    env.push("CLAUDE_CONFIG_DIR=/vault/.claude");
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}`);
    env.push("IS_SANDBOX=1");
  }

  try {
    const container = await docker.createContainer({
      Image: state.config.imageName || defaultImageName,
      name: `ghostbox-${name}`,
      Env: env,
      ExposedPorts: buildExposedPorts(),
      HostConfig: {
        Binds: binds,
        PortBindings: buildPortBindings(ghost.portBase),
        Memory: 1024 * 1024 * 1024,
        CpuShares: 512
      }
    });

    await container.start();
    await waitForHealth(name, ghost.portBase);
    return container.id;
  } catch (error: unknown) {
    logDockerConnectionIssue(error, { name, operation });
    throw error;
  }
};

export const getStatePath = (): string => {
  return join(getHomeDirectory(), ".ghostbox", "state.json");
};

export const loadState = async (): Promise<GhostboxState> => {
  return loadStateFile(getStatePath());
};

export const saveState = async (state: GhostboxState): Promise<void> => {
  const statePath = getStatePath();
  await writeFile(statePath, JSON.stringify(state, null, 2));
};

type GhostCallOptions = Omit<RequestInit, "headers"> & {
  decodeError?: boolean;
  errorMessage: string;
  headers?: Record<string, string>;
};

const callGhost = async (name: string, path: string, options: GhostCallOptions): Promise<Response> => {
  const { decodeError = true, errorMessage, headers, ...requestInit } = options;
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  if (ghost.status !== "running") {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}${path}`, {
    ...requestInit,
    headers: {
      ...headers,
      ...getGhostAuthHeaders(ghost)
    }
  });

  if (response.ok) {
    return response;
  }

  let message = `${errorMessage} with status ${response.status}.`;

  if (decodeError) {
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.length > 0) {
        message = payload.error;
      }
    } catch {
      // Ignore invalid JSON error payloads.
    }
  }

  throw new Error(message);
};

export const getNextPortBase = (state: GhostboxState): number => {
  const usedPorts = new Set<number>();
  for (const ghost of Object.values(state.ghosts)) {
    usedPorts.add(ghost.portBase);
  }

  let portBase = 3100;
  while (usedPorts.has(portBase)) {
    portBase += 10;
  }

  return portBase;
};

export const reconcileGhostStates = async (): Promise<{ started: string[]; marked: string[] }> => {
  const state = await loadState();
  const started: string[] = [];
  const marked: string[] = [];

  for (const [name, ghost] of Object.entries(state.ghosts)) {
    if (ghost.status !== "running") continue;

    // Check if container is actually running
    try {
      const container = docker.getContainer(ghost.containerId);
      const info = await container.inspect();
      if (info.State.Running) continue;

      // Container exists but stopped - remove it so we can recreate
      await container.remove({ force: true }).catch(() => {});
    } catch {
      // Container doesn't exist at all - that's fine
    }

    // Also remove by name in case an old container with the same name is lingering
    try {
      const namedContainer = docker.getContainer(`ghostbox-${name}`);
      await namedContainer.remove({ force: true });
    } catch {
      // No lingering container with that name
    }

    ghost.status = "stopped";
    marked.push(name);
    log.info({ name }, "Ghost container not running - restarting");
  }

  await saveState(state);
  for (const name of marked) {
    const ghost = state.ghosts[name];
    if (ghost) {
      publishGhostUpsertEvent(name, ghost);
    }
  }

  // Restart all ghosts that need it
  for (const name of marked) {
    try {
      await wakeGhost(name);
      started.push(name);
      log.info({ name }, "Ghost restarted");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ name, err: message }, "Failed to restart ghost");
    }
  }

  return { started, marked };
};

export const listGhosts = async (): Promise<Record<string, GhostState>> => {
  const state = await loadState();
  return state.ghosts;
};

export const getGhost = async (name: string): Promise<GhostState> => {
  const state = await loadState();
  return getGhostFromState(state, name);
};

export const updateGhost = async (
  name: string,
  update: Partial<Pick<GhostState, "model" | "provider">>
): Promise<GhostState> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  if (typeof update.model === "string") {
    ghost.model = update.model;
  }

  if (typeof update.provider === "string") {
    ghost.provider = update.provider;
  }

  await saveState(state);
  publishGhostUpsertEvent(name, ghost);
  return ghost;
};

export const getConfig = async (): Promise<GhostboxConfig> => {
  const state = await loadState();
  return state.config;
};

export const generateApiKey = async (name: string, label: string): Promise<GhostApiKey> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  const apiKey = createGhostApiKey(label);

  ghost.apiKeys.push(apiKey);
  await saveState(state);

  return apiKey;
};

export const revokeApiKey = async (name: string, keyId: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  const nextApiKeys = ghost.apiKeys.filter((apiKey) => apiKey.id !== keyId);

  if (nextApiKeys.length === ghost.apiKeys.length) {
    throw new Error(`API key "${keyId}" not found for ghost "${name}".`);
  }

  ghost.apiKeys = nextApiKeys;
  await saveState(state);
};

export const listApiKeys = async (name: string): Promise<GhostApiKey[]> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  return ghost.apiKeys.map((apiKey) => ({
    ...apiKey,
    key: maskGhostApiKey(apiKey.key)
  }));
};

export const spawnGhost = async (
  name: string,
  provider: string,
  model: string,
  systemPrompt?: string
): Promise<void> => {
  const state = await loadState();
  if (state.ghosts[name]) {
    throw new Error(`Ghost "${name}" already exists.`);
  }

  await initVault(name);
  await ensureGhostPiAgent(name);
  await ensureBaseExtensions();

  const portBase = getNextPortBase(state);
  const resolvedModel = resolveProviderModel(provider, model, state.config.defaultProvider);
  log.info({ name, model: resolvedModel.fullModel, portBase, provider: resolvedModel.provider }, "Spawning ghost");
  const ghost: GhostState = {
    containerId: "",
    portBase,
    model: resolvedModel.model,
    provider: resolvedModel.provider,
    adapter: resolvedModel.provider === "anthropic" ? "claude-code" : "pi",
    imageVersion: "",
    status: "running",
    createdAt: new Date().toISOString(),
    systemPrompt: systemPrompt ?? null,
    apiKeys: [createGhostApiKey("default")]
  };

  const containerId = await startGhostContainer(state, name, ghost, resolvedModel.fullModel, systemPrompt, "spawn");

  ghost.containerId = containerId;
  ghost.imageVersion = state.config.imageVersion;
  state.ghosts[name] = ghost;
  await saveState(state);
  publishGhostUpsertEvent(name, ghost);
};

export const killGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  log.info({ name }, "Killing ghost");

  await commitVault(name);

  try {
    const container = docker.getContainer(ghost.containerId);
    await container.remove({ force: true });
  } catch (error: unknown) {
    logDockerConnectionIssue(error, { name, operation: "kill" });
    throw error;
  }

  ghost.status = "stopped";
  await saveState(state);
  publishGhostUpsertEvent(name, ghost);
};

export const wakeGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  log.info({ name }, "Waking ghost");

  if (ghost.status !== "stopped") {
    throw new Error(`Ghost "${name}" is not stopped.`);
  }

  // Remove any lingering container with this name (stopped or dead)
  if (ghost.containerId) {
    try {
      await docker.getContainer(ghost.containerId).remove({ force: true });
    } catch {
      // Container already gone
    }
  }
  try {
    await docker.getContainer(`ghostbox-${name}`).remove({ force: true });
  } catch {
    // No lingering container with that name
  }

  await ensureGhostPiAgent(name);
  await ensureBaseExtensions();

  const resolvedModel = resolveProviderModel(ghost.provider, ghost.model, state.config.defaultProvider);
  const containerId = await startGhostContainer(
    state,
    name,
    ghost,
    resolvedModel.fullModel,
    ghost.systemPrompt,
    "wake"
  );

  ghost.containerId = containerId;
  ghost.status = "running";
  ghost.imageVersion = state.config.imageVersion;
  await saveState(state);
  publishGhostUpsertEvent(name, ghost);
};

const refreshGhostAuth = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if ((ghost.adapter ?? inferAdapterFromProvider(ghost.provider)) === "claude-code") {
    await ensureClaudeCodeRuntimeFiles(name);
    return;
  }

  const ghostPiPath = getGhostPiAgentPath(name);
  await mkdir(ghostPiPath, { recursive: true });

  const sharedPath = getSharedPiAgentPath();
  const settingsSource = join(sharedPath, "settings.json");
  const settingsDest = join(ghostPiPath, "settings.json");

  if (existsSync(settingsSource)) {
    await copyFile(settingsSource, settingsDest);
  }
};

export const sendMessage = async function* (
  name: string,
  prompt: string,
  model?: string,
  images?: GhostImage[],
  streamingBehavior?: GhostStreamingBehavior
): AsyncGenerator<GhostMessage> {
  const response = await callGhost(name, "/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      ...(model ? { model } : {}),
      ...(images ? { images } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {})
    }),
    signal: AbortSignal.timeout(1_800_000),
    errorMessage: "Ghost message request failed",
    decodeError: false
  });

  if (!response.body) {
    throw new Error("Ghost message response did not include a body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const message = parseGhostMessage(trimmed);
      if (message.type === "heartbeat") continue;
      if (message.type === "result" && message.sessionId) {
        publishMessageCompletedEvent(name, message.sessionId, message.text.slice(0, 240));
      }
      yield message;
    }
  }

  const finalLine = buffer.trim();
  if (finalLine.length > 0) {
    const message = parseGhostMessage(finalLine);
    if (message.type !== "heartbeat") {
      if (message.type === "result" && message.sessionId) {
        publishMessageCompletedEvent(name, message.sessionId, message.text.slice(0, 240));
      }
      yield message;
    }
  }
};

export const steerGhost = async (
  name: string,
  prompt: string,
  images?: GhostImage[]
): Promise<GhostQueueEnqueueResponse> => {
  const response = await callGhost(name, "/steer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      ...(images ? { images } : {})
    }),
    errorMessage: "Ghost steer failed"
  });

  return (await response.json()) as GhostQueueEnqueueResponse;
};

export const getGhostQueue = async (name: string): Promise<GhostQueueState> => {
  const response = await callGhost(name, "/queue", {
    errorMessage: "Ghost queue failed"
  });

  return (await response.json()) as GhostQueueState;
};

export const clearGhostQueue = async (name: string): Promise<GhostQueueClearResponse> => {
  const response = await callGhost(name, "/clear-queue", {
    method: "POST",
    errorMessage: "Ghost clear queue failed"
  });

  return (await response.json()) as GhostQueueClearResponse;
};

export const getGhostHealth = async (name: string): Promise<boolean> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  try {
    const response = await fetch(`http://localhost:${ghost.portBase}/health`);
    return response.status === 200;
  } catch {
    return false;
  }
};

export const getGhostTimeline = async (name: string, options?: HistoryRequestOptions): Promise<TimelineResponse> => {
  const query = new URLSearchParams();

  if (options?.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options?.cursor !== undefined) {
    query.set("cursor", options.cursor);
  }

  const path = query.size > 0 ? `/timeline?${query.toString()}` : "/timeline";
  const response = await callGhost(name, path, {
    errorMessage: "Ghost timeline request failed",
    decodeError: false
  });

  return (await response.json()) as TimelineResponse;
};

export const getGhostSessions = async (name: string): Promise<SessionListResponse> => {
  const response = await callGhost(name, "/sessions", {
    errorMessage: "Ghost sessions request failed",
    decodeError: false
  });

  return (await response.json()) as SessionListResponse;
};

export const getGhostStats = async (name: string): Promise<Record<string, unknown>> => {
  const response = await callGhost(name, "/stats", {
    errorMessage: "Ghost stats request failed",
    decodeError: false
  });

  return (await response.json()) as Record<string, unknown>;
};

export const getGhostRuntimeMeta = async (name: string): Promise<GhostRuntimeMeta> => {
  const response = await callGhost(name, "/runtime/meta", {
    errorMessage: "Ghost runtime meta request failed",
    decodeError: false
  });

  return (await response.json()) as GhostRuntimeMeta;
};

const ensureGhostCapability = async (
  name: string,
  capability: GhostRuntimeCapability,
  operation: string
): Promise<GhostRuntimeMeta> => {
  const runtimeMeta = await getGhostRuntimeMeta(name);

  if (!runtimeMeta.supportedCapabilities.includes(capability)) {
    throw new Error(`${operation} is not supported by the ${runtimeMeta.adapter} adapter.`);
  }

  return runtimeMeta;
};

export const reloadGhost = async (name: string): Promise<void> => {
  await ensureGhostCapability(name, "reload", "Reload");
  await callGhost(name, "/reload", {
    method: "POST",
    errorMessage: "Ghost reload failed"
  });
};

export const abortGhost = async (name: string): Promise<void> => {
  await callGhost(name, "/abort", {
    method: "POST",
    errorMessage: "Ghost abort failed"
  });
};

export const killBackgroundTask = async (
  name: string,
  taskId: string
): Promise<{ status: "killed"; taskId: string }> => {
  await ensureGhostCapability(name, "backgroundTaskKill", "Background task killing");
  const path = `/tasks/${encodeURIComponent(taskId)}/kill`;
  const response = await callGhost(name, path, {
    method: "POST",
    errorMessage: "Ghost background task kill failed"
  });

  return (await response.json()) as { status: "killed"; taskId: string };
};

export const newGhostSession = async (name: string): Promise<{ status: "new_session"; sessionId: string }> => {
  const response = await callGhost(name, "/new", {
    method: "POST",
    errorMessage: "Ghost new session failed"
  });

  return (await response.json()) as { status: "new_session"; sessionId: string };
};

export const switchGhostSession = async (
  name: string,
  sessionId: string
): Promise<{ status: "switched"; sessionId: string }> => {
  const response = await callGhost(name, "/sessions/switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId }),
    errorMessage: "Ghost switch session failed"
  });

  return (await response.json()) as { status: "switched"; sessionId: string };
};

export const renameGhostSession = async (
  name: string,
  sessionId: string,
  sessionName: string
): Promise<{ status: "renamed"; sessionId: string; name: string | null }> => {
  const response = await callGhost(name, "/sessions/rename", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId, name: sessionName }),
    errorMessage: "Ghost rename session failed"
  });

  return (await response.json()) as { status: "renamed"; sessionId: string; name: string | null };
};

export const deleteGhostSession = async (
  name: string,
  sessionId: string
): Promise<{ status: "deleted"; sessionId: string }> => {
  const response = await callGhost(name, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    errorMessage: "Ghost delete session failed"
  });

  return (await response.json()) as { status: "deleted"; sessionId: string };
};

export const nudgeGhost = async (
  name: string,
  event: string = "self",
  reason: string = "orchestrator"
): Promise<void> => {
  await ensureGhostCapability(name, "nudge", "Nudging");
  await callGhost(name, "/nudge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ event, reason }),
    errorMessage: "Ghost nudge failed"
  });
};

export const removeGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  if (ghost.status === "running") {
    await killGhost(name);
  }

  const refreshedState = await loadState();
  const vaultPath = getVaultPath(name);

  const { exitCode, stderr: trashStdErr } = await new Promise<{ exitCode: number; stderr: string }>(
    (resolve, reject) => {
      const proc = nodeSpawn("trash", [vaultPath], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code: number | null) => resolve({ exitCode: code ?? 1, stderr }));
    }
  );

  if (exitCode !== 0) {
    throw new Error(`Trash command failed: ${trashStdErr.trim()}`);
  }

  delete refreshedState.ghosts[name];
  await saveState(refreshedState);
  publishGhostRemoveEvent(name);
};

export const mergeGhosts = async (source: string, target: string): Promise<string> => {
  const state = await loadState();
  const sourceGhost = getGhostFromState(state, source);
  const targetGhost = getGhostFromState(state, target);

  if (sourceGhost.status !== "stopped" || targetGhost.status !== "stopped") {
    throw new Error("Both ghosts must be stopped before merge.");
  }

  return mergeVaults(source, target);
};

export const upgradeGhosts = async (
  dockerDir: string
): Promise<{ upgraded: string[]; skipped: string[]; failed: string[] }> => {
  const state = await loadState();
  const imageVersion = computeImageVersion(dockerDir);
  state.config.imageVersion = imageVersion;
  await saveState(state);

  const upgraded: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const [name, ghost] of Object.entries(state.ghosts)) {
    if (ghost.status !== "running") continue;
    if (ghost.imageVersion === imageVersion) {
      skipped.push(name);
      continue;
    }

    log.info({ name, from: ghost.imageVersion, to: imageVersion }, "Upgrading ghost");

    try {
      await refreshGhostAuth(name);
      await killGhost(name);
      await wakeGhost(name);
      const freshState = await loadState();
      freshState.ghosts[name].imageVersion = imageVersion;
      await saveState(freshState);
      upgraded.push(name);
      log.info({ name }, "Upgrade complete");
    } catch (error) {
      log.error({ name, err: error }, "Upgrade failed");
      failed.push(name);
    }
  }

  return { upgraded, skipped, failed };
};
