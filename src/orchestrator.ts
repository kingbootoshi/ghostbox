import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  type GhostApiKey,
  type GhostImage,
  type GhostboxConfig,
  type HistoryResponse,
  type GhostMessage,
  type GhostState,
  type GhostboxState,
} from './types';
import {
  commitVault,
  getVaultPath,
  initVault,
  mergeVaults,
} from './vault';
import { createLogger } from './logger';

const defaultImageName = 'ghostbox-agent';
const defaultProvider = 'anthropic';
const getHomeDirectory = (): string => process.env.HOME ?? homedir();
const getGhostPiAgentPath = (name: string): string =>
  join(getHomeDirectory(), '.ghostbox', 'ghosts', name, 'pi-agent');
const getSharedPiAgentPath = (): string =>
  join(getHomeDirectory(), '.pi', 'agent');
const getBasePath = (): string =>
  join(getHomeDirectory(), '.ghostbox', 'base');
export const getBaseExtensionsPath = (): string =>
  join(getBasePath(), 'extensions');
const getBaseAgentsPath = (): string =>
  join(getBasePath(), 'AGENTS.md');

const baseAgentsContent = `# Ghostbox Agent Core

You are a persistent agent with memory that spans sessions. Your vault at /vault is your brain on disk. You have two memory systems and must actively use both.

## Memory System

### 1. Warm Memory (memory.json - injected into your prompt)

Your facts and vault map from \`/vault/memory.json\` are loaded into your system prompt at session start. This is your "working memory" - what you immediately know without searching.

**CLI: ghost-memory**
\`\`\`
ghost-memory add "content" [category]     # Save a fact (user|env|project|learning)
ghost-memory update <id> "new content"    # Update a fact
ghost-memory remove <id>                  # Remove a stale fact
ghost-memory search "query"               # Search your facts
ghost-memory map <path> "summary"         # Index a vault file you created/found
ghost-memory unmap <path>                 # Remove stale map entry
ghost-memory show                         # See everything
\`\`\`

Categories:
- **user**: Who is the user, preferences, communication style, corrections
- **env**: Environment details, tool versions, API quirks, system config
- **project**: Current project context, goals, decisions, constraints
- **learning**: Lessons learned, patterns discovered, things to remember

### 2. Deep Memory (vault files - searched on demand via qmd)

Your vault contains detailed knowledge in markdown files, code, research notes. Use \`qmd\` to find and read them.

**CLI: qmd**
\`\`\`
qmd search "query"                        # Search vault files by content (ripgrep)
qmd search "query" --type md              # Search only markdown
qmd read <path>                           # Read a vault file
qmd read <path> --section "heading"       # Read a specific section
qmd list [pattern]                        # List vault files (glob)
qmd tree [depth]                          # Vault directory structure
qmd index                                 # Rebuild vault_map from disk
qmd recent [N]                            # Recently modified files
qmd headings <path>                       # Show headings in a file
qmd summary                               # Quick vault overview
\`\`\`

### How Memory Works Together

Warm memory (facts + vault_map) is your **navigation map**. It tells you WHAT you know and WHERE to find details. Deep memory (vault files via qmd) is the **actual knowledge**. The workflow:

1. Check your injected facts for quick answers
2. Check vault_map for relevant files
3. Use \`qmd read\` or \`qmd search\` to get the details
4. After learning something new, save it:
   - Quick fact -> \`ghost-memory add\`
   - Detailed notes -> write to \`/vault/knowledge/\` + \`ghost-memory map\`

### Memory Discipline (CRITICAL)

**Every session, you MUST:**
- Read your injected memory block at the start (it is in your system prompt)
- Before responding to complex questions, check if your vault has relevant notes
- After completing meaningful work, save what you learned
- Update or remove facts that are wrong or outdated
- Map new vault files you create so future sessions find them
- Run \`qmd index\` periodically to keep vault_map in sync with actual files

**What to save as facts:**
- User corrections and preferences (highest priority - prevents repeat corrections)
- Environment details and API quirks discovered
- Project conventions and decisions
- Stable patterns that will matter in future sessions

**What to save as vault files (knowledge/):**
- Research findings and detailed notes
- Architecture decisions with rationale
- Multi-step procedures and runbooks
- Reference material

**What NOT to save:**
- Temporary task state or progress
- Things already in git history
- Duplicate information across facts and files

### Proactive Research Protocol

Before responding to ANY non-trivial question:

1. **Check memory** - Do your facts or vault_map mention anything relevant?
2. **Search vault** - \`qmd search\` for related content in your files
3. **Search external** - \`exa-search\` for current information if needed
4. **Then respond** - with actual context, not guesses

This applies especially to engineering tasks. Never guess at APIs, configs, or patterns when you can look them up. Your vault may already have the answer from a previous session.

## Vault Structure

\`\`\`
/vault/
  CLAUDE.md             # Your identity and learned instructions
  AGENTS.md             # Symlink to CLAUDE.md
  memory.json           # Warm memory store (facts + vault_map)
  knowledge/            # Detailed notes, research, findings
  code/                 # Projects, scripts, tools
  .pi/extensions/       # Pi agent extensions (self-evolution)
\`\`\`

## Other Tools

- \`ghost-save "message"\` - Commit and push vault to GitHub
- \`exa-search "query"\` - Web search via Exa
- \`exa-search --code "query"\` - Code search via Exa
- Base extensions in /root/.pi/agent/extensions/ are read-only
- Create your own extensions in /vault/.pi/extensions/

## Self-Evolution

You can extend your own capabilities by writing TypeScript extensions to /vault/.pi/extensions/. Extensions persist in your vault and compound over sessions.
`;

const ensureGhostPiAgent = async (name: string): Promise<void> => {
  const ghostPiPath = getGhostPiAgentPath(name);
  await mkdir(ghostPiPath, { recursive: true });

  const sharedPath = getSharedPiAgentPath();
  for (const file of ['auth.json', 'settings.json']) {
    const source = join(sharedPath, file);
    const dest = join(ghostPiPath, file);
    if (existsSync(source) && !existsSync(dest)) {
      await copyFile(source, dest);
    }
  }

  const baseAgentsSource = getBaseAgentsPath();
  const agentsDest = join(ghostPiPath, 'AGENTS.md');
  if (existsSync(baseAgentsSource)) {
    await copyFile(baseAgentsSource, agentsDest);
  }
};

const writeFileIfMissing = async (path: string, content: string): Promise<void> => {
  if (!existsSync(path)) {
    await writeFile(path, content);
  }
};

export const ensureBaseExtensions = async (): Promise<void> => {
  const basePath = getBasePath();
  const baseExtensionsPath = getBaseExtensionsPath();

  await mkdir(basePath, { recursive: true });
  await mkdir(baseExtensionsPath, { recursive: true });

  await writeFileIfMissing(getBaseAgentsPath(), baseAgentsContent);
};

const log = createLogger('orchestrator');

const docker = new Docker();

const createGhostApiKey = (label: string): GhostApiKey => {
  return {
    id: randomBytes(4).toString('hex'),
    key: `gbox_${randomBytes(16).toString('hex')}`,
    label,
    createdAt: new Date().toISOString(),
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

const getGhostAuthorizationHeader = (ghost: GhostState): string | null => {
  const apiKey = ghost.apiKeys[0];
  return apiKey ? `Bearer ${apiKey.key}` : null;
};

const getGhostAuthHeaders = (ghost: GhostState): Record<string, string> => {
  return getGhostAuthorizationHeader(ghost)
    ? { Authorization: getGhostAuthorizationHeader(ghost) as string }
    : {};
};

const normalizeGhostState = (
  ghost: GhostState | (Omit<GhostState, 'apiKeys'> & { apiKeys?: GhostApiKey[] }),
): GhostState => {
  return {
    ...ghost,
    apiKeys: Array.isArray(ghost.apiKeys) ? ghost.apiKeys : [],
  };
};

const normalizeState = (state: GhostboxState): GhostboxState => {
  return {
    ...state,
    ghosts: Object.fromEntries(
      Object.entries(state.ghosts).map(([name, ghost]) => [name, normalizeGhostState(ghost)]),
    ),
  };
};

const isNodeError = (value: unknown): value is { code?: string } => {
  return typeof value === 'object' && value !== null && 'code' in value;
};

const isDockerConnectionIssue = (error: unknown): boolean => {
  if (!isNodeError(error) || typeof error.code !== 'string') {
    return false;
  }

  return ['ENOENT', 'ECONNREFUSED', 'EACCES', 'ENOTFOUND', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT']
    .includes(error.code);
};

const logDockerConnectionIssue = (
  error: unknown,
  context: { name: string; operation: string },
): void => {
  if (isDockerConnectionIssue(error)) {
    log.error({ err: error, ...context }, 'Docker connection issue');
  }
};

const loadStateFile = async (path: string): Promise<GhostboxState> => {
  try {
    const contents = await Bun.file(path).text();
    return normalizeState(JSON.parse(contents) as GhostboxState);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(
        `State file not found at ${path}. Run ghostbox init to create it first.`,
      );
    }
    throw error;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseGhostMessage = (line: string): GhostMessage => {
  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new Error('Invalid ghost message');
  }

  const record = parsed as Record<string, unknown>;
  const type = record.type;

  if (type === 'assistant') {
    if (typeof record.text !== 'string') throw new Error('Invalid assistant message');
    return { type: 'assistant', text: record.text };
  }

  if (type === 'tool_use') {
    if (typeof record.tool !== 'string') throw new Error('Invalid tool_use message');
    return { type: 'tool_use', tool: record.tool, input: record.input ?? null };
  }

  if (type === 'tool_result') {
    return { type: 'tool_result', output: record.output ?? null };
  }

  if (type === 'result') {
    if (typeof record.text !== 'string' || typeof record.sessionId !== 'string') {
      throw new Error('Invalid result message');
    }
    return {
      type: 'result',
      text: record.text,
      sessionId: record.sessionId,
    };
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
    '3000/tcp': [{ HostPort: String(portBase) }],
  };

  for (let index = 1; index <= 9; index++) {
    ports[`${8000 + index}/tcp`] = [{ HostPort: String(portBase + index) }];
  }

  return ports;
};

const buildExposedPorts = (): Record<string, Record<string, never>> => {
  const ports: Record<string, Record<string, never>> = {
    '3000/tcp': {},
  };

  for (let index = 1; index <= 9; index++) {
    ports[`${8000 + index}/tcp`] = {};
  }

  return ports;
};

const resolveProviderModel = (
  provider: string | null | undefined,
  model: string,
  fallbackProvider = defaultProvider,
): { provider: string; model: string; fullModel: string } => {
  const separatorIndex = model.indexOf('/');
  if (separatorIndex > 0 && separatorIndex < model.length - 1) {
    return {
      provider: model.slice(0, separatorIndex),
      model: model.slice(separatorIndex + 1),
      fullModel: model,
    };
  }

  const resolvedProvider =
    typeof provider === 'string' && provider.length > 0 ? provider : fallbackProvider;

  return {
    provider: resolvedProvider,
    model,
    fullModel: `${resolvedProvider}/${model}`,
  };
};

const waitForHealth = async (name: string, port: number): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    log.debug({ name, attempt: attempt + 1 }, 'Health check');
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

export const getStatePath = (): string => {
  return join(getHomeDirectory(), '.ghostbox', 'state.json');
};

export const loadState = async (): Promise<GhostboxState> => {
  return loadStateFile(getStatePath());
};

export const saveState = async (state: GhostboxState): Promise<void> => {
  const statePath = getStatePath();
  await Bun.write(statePath, JSON.stringify(state, null, 2));
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

export const listGhosts = async (): Promise<Record<string, GhostState>> => {
  const state = await loadState();
  return state.ghosts;
};

export const getGhost = async (name: string): Promise<GhostState> => {
  const state = await loadState();
  return getGhostFromState(state, name);
};

export const getConfig = async (): Promise<GhostboxConfig> => {
  const state = await loadState();
  return state.config;
};

export const generateApiKey = async (
  name: string,
  label: string,
): Promise<GhostApiKey> => {
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
    key: maskGhostApiKey(apiKey.key),
  }));
};

export const spawnGhost = async (
  name: string,
  provider: string,
  model: string,
  systemPrompt?: string,
): Promise<void> => {
  const state = await loadState();
  if (state.ghosts[name]) {
    throw new Error(`Ghost "${name}" already exists.`);
  }

  await initVault(name);
  await ensureGhostPiAgent(name);
  await ensureBaseExtensions();

  const portBase = getNextPortBase(state);
  const resolvedModel = resolveProviderModel(
    provider,
    model,
    state.config.defaultProvider,
  );
  log.info(
    { name, model: resolvedModel.fullModel, portBase, provider: resolvedModel.provider },
    'Spawning ghost',
  );
  const ghost: GhostState = {
    containerId: '',
    portBase,
    model: resolvedModel.model,
    provider: resolvedModel.provider,
    status: 'running',
    createdAt: new Date().toISOString(),
    systemPrompt: systemPrompt ?? null,
    apiKeys: [createGhostApiKey('default')],
  };
  const vaultPath = getVaultPath(name);
  const piAgentPath = getGhostPiAgentPath(name);
  const baseExtensionsPath = getBaseExtensionsPath();
  let containerId = '';

  try {
    const container = await docker.createContainer({
      Image: state.config.imageName || defaultImageName,
      name: `ghostbox-${name}`,
      Env: [
        `GHOSTBOX_MODEL=${resolvedModel.fullModel}`,
        `GHOSTBOX_SYSTEM_PROMPT=${systemPrompt || ''}`,
        `GHOSTBOX_GHOST_NAME=${name}`,
        `GHOSTBOX_GITHUB_TOKEN=${state.config.githubToken || ''}`,
        `GHOSTBOX_GITHUB_REMOTE=${state.config.githubRemote || ''}`,
        `GHOSTBOX_HOST_BASE_PORT=${portBase}`,
        `GHOSTBOX_USER_PORTS=8001-8009`,
        getGhostboxApiKeysEnv(ghost),
      ],
      ExposedPorts: buildExposedPorts(),
      HostConfig: {
        Binds: [
          `${vaultPath}:/vault`,
          `${piAgentPath}:/root/.pi/agent`,
          `${baseExtensionsPath}:/root/.pi/agent/extensions:ro`,
        ],
        PortBindings: buildPortBindings(portBase),
        Memory: 1024 * 1024 * 1024,
        CpuShares: 512,
      },
    });

    containerId = container.id;
    await container.start();
    await waitForHealth(name, portBase);
  } catch (error: unknown) {
    logDockerConnectionIssue(error, { name, operation: 'spawn' });
    throw error;
  }

  ghost.containerId = containerId;
  state.ghosts[name] = ghost;
  await saveState(state);
};

export const killGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  log.info({ name }, 'Killing ghost');

  await commitVault(name);

  try {
    const container = docker.getContainer(ghost.containerId);
    await container.remove({ force: true });
  } catch (error: unknown) {
    logDockerConnectionIssue(error, { name, operation: 'kill' });
    throw error;
  }

  ghost.status = 'stopped';
  await saveState(state);
};

export const wakeGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  log.info({ name }, 'Waking ghost');

  if (ghost.status !== 'stopped') {
    throw new Error(`Ghost "${name}" is not stopped.`);
  }

  await ensureGhostPiAgent(name);
  await ensureBaseExtensions();

  const vaultPath = getVaultPath(name);
  const piAgentPath = getGhostPiAgentPath(name);
  const baseExtensionsPath = getBaseExtensionsPath();
  const resolvedModel = resolveProviderModel(
    ghost.provider,
    ghost.model,
    state.config.defaultProvider,
  );
  let containerId = '';

  try {
    const container = await docker.createContainer({
      Image: state.config.imageName || defaultImageName,
      name: `ghostbox-${name}`,
      Env: [
        `GHOSTBOX_MODEL=${resolvedModel.fullModel}`,
        `GHOSTBOX_SYSTEM_PROMPT=${ghost.systemPrompt || ''}`,
        `GHOSTBOX_GHOST_NAME=${name}`,
        `GHOSTBOX_GITHUB_TOKEN=${state.config.githubToken || ''}`,
        `GHOSTBOX_GITHUB_REMOTE=${state.config.githubRemote || ''}`,
        `GHOSTBOX_HOST_BASE_PORT=${ghost.portBase}`,
        `GHOSTBOX_USER_PORTS=8001-8009`,
        getGhostboxApiKeysEnv(ghost),
      ],
      ExposedPorts: buildExposedPorts(),
      HostConfig: {
        Binds: [
          `${vaultPath}:/vault`,
          `${piAgentPath}:/root/.pi/agent`,
          `${baseExtensionsPath}:/root/.pi/agent/extensions:ro`,
        ],
        PortBindings: buildPortBindings(ghost.portBase),
        Memory: 1024 * 1024 * 1024,
        CpuShares: 512,
      },
    });

    containerId = container.id;
    await container.start();
    await waitForHealth(name, ghost.portBase);
  } catch (error: unknown) {
    logDockerConnectionIssue(error, { name, operation: 'wake' });
    throw error;
  }

  ghost.containerId = containerId;
  ghost.status = 'running';
  await saveState(state);
};

export const sendMessage = async function* (
  name: string,
  prompt: string,
  model?: string,
  images?: GhostImage[],
): AsyncGenerator<GhostMessage> {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getGhostAuthHeaders(ghost),
    },
    body: JSON.stringify({
      prompt,
      ...(model ? { model } : {}),
      ...(images ? { images } : {}),
    }),
    signal: AbortSignal.timeout(1_800_000),
  });

  if (!response.ok) {
    throw new Error(`Ghost message request failed with status ${response.status}.`);
  }

  if (!response.body) {
    throw new Error('Ghost message response did not include a body.');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const message = parseGhostMessage(trimmed);
      yield message;
    }
  }

  const finalLine = buffer.trim();
  if (finalLine.length > 0) {
    const message = parseGhostMessage(finalLine);
    yield message;
  }
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

export const getGhostHistory = async (name: string): Promise<HistoryResponse> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/history`, {
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (!response.ok) {
    throw new Error(`Ghost history request failed with status ${response.status}.`);
  }

  return await response.json() as HistoryResponse;
};

export const getGhostStats = async (name: string): Promise<Record<string, unknown>> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/stats`, {
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (!response.ok) {
    throw new Error(`Ghost stats request failed with status ${response.status}.`);
  }

  return await response.json() as Record<string, unknown>;
};

export const reloadGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/reload`, {
    method: 'POST',
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (response.ok) {
    return;
  }

  let message = `Ghost reload failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      message = payload.error;
    }
  } catch {
    // Ignore invalid JSON error payloads.
  }

  throw new Error(message);
};

export const compactGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/compact`, {
    method: 'POST',
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (response.ok) {
    return;
  }

  let message = `Ghost compact failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      message = payload.error;
    }
  } catch {
    // Ignore invalid JSON error payloads.
  }

  throw new Error(message);
};

export const abortGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/abort`, {
    method: 'POST',
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (response.ok) {
    return;
  }

  let message = `Ghost abort failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      message = payload.error;
    }
  } catch {
    // Ignore invalid JSON error payloads.
  }

  throw new Error(message);
};

export const newGhostSession = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);
  if (ghost.status !== 'running') {
    throw new Error(`Ghost "${name}" is not running.`);
  }

  const response = await fetch(`http://localhost:${ghost.portBase}/new`, {
    method: 'POST',
    headers: {
      ...getGhostAuthHeaders(ghost),
    },
  });

  if (response.ok) {
    return;
  }

  let message = `Ghost new session failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      message = payload.error;
    }
  } catch {
    // Ignore invalid JSON error payloads.
  }

  throw new Error(message);
};

export const removeGhost = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = getGhostFromState(state, name);

  if (ghost.status === 'running') {
    await killGhost(name);
  }

  const refreshedState = await loadState();
  const vaultPath = getVaultPath(name);

  const trash = Bun.spawn(['trash', vaultPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [trashStdErr, exitCode] = await Promise.all([
    new Response(trash.stderr).text(),
    trash.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`Trash command failed: ${trashStdErr.trim()}`);
  }

  delete refreshedState.ghosts[name];
  await saveState(refreshedState);
};

export const mergeGhosts = async (source: string, target: string): Promise<string> => {
  const state = await loadState();
  const sourceGhost = getGhostFromState(state, source);
  const targetGhost = getGhostFromState(state, target);

  if (sourceGhost.status !== 'stopped' || targetGhost.status !== 'stopped') {
    throw new Error('Both ghosts must be stopped before merge.');
  }

  return mergeVaults(source, target);
};
