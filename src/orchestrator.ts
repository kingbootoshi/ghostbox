import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type GhostApiKey,
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
  const piAgentPath = join(getHomeDirectory(), '.pi', 'agent');
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

  const vaultPath = getVaultPath(name);
  const piAgentPath = join(getHomeDirectory(), '.pi', 'agent');
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
      ...(getGhostAuthorizationHeader(ghost)
        ? { Authorization: getGhostAuthorizationHeader(ghost) as string }
        : {}),
    },
    body: JSON.stringify({
      prompt,
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
