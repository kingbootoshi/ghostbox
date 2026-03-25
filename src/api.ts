import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  abortGhost,
  compactGhost,
  generateApiKey,
  getConfig,
  getGhost,
  getGhostHealth,
  getGhostHistory,
  getGhostStats,
  killGhost,
  listApiKeys,
  listGhosts,
  loadState,
  mergeGhosts,
  newGhostSession,
  reloadGhost,
  removeGhost,
  saveState,
  revokeApiKey,
  sendMessage,
  spawnGhost,
  wakeGhost,
} from './orchestrator';
import type {
  GhostImage,
  GhostboxConfig,
  GhostboxConfigResponse,
  GhostboxConfigSensitiveStatus,
  GhostboxConfigUpdate,
  VaultEntry,
} from './types';
import { commitVault, getVaultPath } from './vault';
import { createLogger } from './logger';

const port = 3200;
const log = createLogger('api');
const app = new Hono();

type ApiStatusCode = 400 | 404 | 409 | 500;

class ApiError extends Error {
  status: ApiStatusCode;

  constructor(status: ApiStatusCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type SpawnBody = {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
};

type MessageBody = {
  prompt?: unknown;
  model?: unknown;
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

type ConfigUpdateBody = GhostboxConfigUpdate & Record<string, unknown>;

type LegacyConfig = GhostboxConfig & {
  defaultProvider?: string | null;
};

const isNodeError = (value: unknown): value is { code?: string } => {
  return typeof value === 'object' && value !== null && 'code' in value;
};

const ensureGhostExists = async (name: string): Promise<string> => {
  await getGhost(name);
  return resolve(getVaultPath(name));
};

const toVaultApiPath = (vaultPath: string, fullPath: string): string => {
  const nextRelativePath = relative(vaultPath, fullPath);
  if (!nextRelativePath) {
    return '/';
  }

  return `/${nextRelativePath.split(sep).join('/')}`;
};

const resolveVaultItemPath = async (
  ghostName: string,
  inputPath: string | undefined,
  options?: { allowRoot?: boolean },
): Promise<{ vaultPath: string; fullPath: string; apiPath: string }> => {
  const vaultPath = await ensureGhostExists(ghostName);
  const rawPath = inputPath?.trim() ?? '';
  const requestedPath = rawPath || '/';

  if (!rawPath && options?.allowRoot !== true) {
    throw new ApiError(400, 'Missing path');
  }

  if (requestedPath.includes('..')) {
    throw new ApiError(400, 'Invalid path');
  }

  const relativePath = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const fullPath = resolve(vaultPath, relativePath);
  const vaultPrefix = vaultPath.endsWith(sep) ? vaultPath : `${vaultPath}${sep}`;

  if (fullPath !== vaultPath && !fullPath.startsWith(vaultPrefix)) {
    throw new ApiError(400, 'Invalid path');
  }

  if (fullPath === vaultPath && options?.allowRoot !== true) {
    throw new ApiError(400, 'Invalid path');
  }

  return {
    vaultPath,
    fullPath,
    apiPath: toVaultApiPath(vaultPath, fullPath),
  };
};

const getVaultEntryType = (stats: Awaited<ReturnType<typeof stat>>): VaultEntry['type'] => {
  return stats.isDirectory() ? 'directory' : 'file';
};

const readVaultEntries = async (vaultPath: string, directoryPath: string): Promise<VaultEntry[]> => {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolve(directoryPath, entry.name);
      const entryStats = await stat(entryPath);
      const entryType = getVaultEntryType(entryStats);

      return {
        name: entry.name,
        path: toVaultApiPath(vaultPath, entryPath),
        type: entryType,
        size: entryType === 'file' ? entryStats.size : undefined,
        modified: entryStats.mtime.toISOString(),
      } satisfies VaultEntry;
    }),
  );

  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
};

const throwVaultFsError = (error: unknown): never => {
  if (isNodeError(error) && error.code === 'ENOENT') {
    throw new ApiError(404, 'Path not found');
  }

  throw error;
};

const parseProviderAndModel = (
  value: string,
): { provider: string | null; model: string } => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { provider: null, model: trimmed };
  }

  return {
    provider: trimmed.slice(0, separatorIndex).trim().toLowerCase(),
    model: trimmed.slice(separatorIndex + 1).trim(),
  };
};

const getDefaultProvider = (config: LegacyConfig): string => {
  const parsed = parseProviderAndModel(config.defaultModel);

  return (
    (typeof config.defaultProvider === 'string' && config.defaultProvider.trim().length > 0
      ? config.defaultProvider
      : parsed.provider ?? 'anthropic')
      .trim()
      .toLowerCase()
  );
};

const hasConfigValue = (value: string | null | undefined): boolean => {
  return typeof value === 'string' && value.length > 0;
};

const maskSensitiveConfigValue = (value: string | null | undefined): string => {
  if (!hasConfigValue(value)) {
    return '';
  }

  const sensitiveValue = value as string;
  const prefix = sensitiveValue.slice(0, 12);
  const suffix = sensitiveValue.slice(-4);
  return `${prefix}...${suffix}`;
};

const toConfigSensitiveStatus = (config: GhostboxConfig): GhostboxConfigSensitiveStatus => {
  return {
    githubToken: hasConfigValue(config.githubToken),
    telegramToken: hasConfigValue(config.telegramToken),
  };
};

const toConfigResponse = (config: GhostboxConfig): GhostboxConfigResponse => {
  return {
    ...config,
    githubToken: maskSensitiveConfigValue(config.githubToken),
    telegramToken: maskSensitiveConfigValue(config.telegramToken),
    hasSensitive: toConfigSensitiveStatus(config),
  };
};

const normalizeRequiredConfigValue = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new ApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new ApiError(400, `Missing ${field}`);
  }

  return trimmed;
};

const normalizeNullableConfigValue = (value: unknown, field: string): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeSensitiveConfigValue = (
  value: unknown,
  field: 'githubToken' | 'telegramToken',
): string | null | undefined => {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ApiError(400, `Invalid ${field}`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('...')) {
    return undefined;
  }

  return trimmed;
};

const normalizeGhostImages = (value: unknown): GhostImage[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, 'Invalid images');
  }

  return value.map((image) => {
    if (typeof image !== 'object' || image === null) {
      throw new ApiError(400, 'Invalid images');
    }

    const { mediaType, data } = image as {
      mediaType?: unknown;
      data?: unknown;
    };

    if (typeof mediaType !== 'string' || typeof data !== 'string') {
      throw new ApiError(400, 'Invalid images');
    }

    return { mediaType, data };
  });
};

const getErrorStatus = (error: unknown): ApiStatusCode => {
  if (error instanceof ApiError) {
    return error.status;
  }

  const message = error instanceof Error ? error.message : 'Internal server error';

  if (message.includes('not found')) {
    return 404;
  }

  if (
    message.includes('already exists') ||
    message.includes('is not running') ||
    message.includes('is not stopped') ||
    message.includes('must be stopped')
  ) {
    return 409;
  }

  if (
    message.includes('Invalid') ||
    message.includes('Missing') ||
    message.includes('Provider mismatch') ||
    message.includes('Unsupported provider') ||
    message.includes('Model is required')
  ) {
    return 400;
  }

  return 500;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Internal server error';
};

const parseJsonBody = async <T>(c: Context): Promise<T> => {
  try {
    return await c.req.json<T>();
  } catch {
    throw new ApiError(400, 'Invalid JSON body');
  }
};

const handleRoute = async (
  c: Context,
  handler: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await handler();
  } catch (error) {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error);

    log.error(
      { err: error, method: c.req.method, path: c.req.path, status },
      'API request failed',
    );

    return c.json({ error: message }, { status });
  }
};

app.use('/api/*', cors({ origin: '*' }));

app.use('/api/*', async (c, next) => {
  const startedAt = Date.now();

  await next();

  log.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    },
    'API request complete',
  );
});

app.get('/api/ghosts', (c) =>
  handleRoute(c, async () => {
    return c.json(await listGhosts());
  }));

app.get('/api/ghosts/:name', (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhost(c.req.param('name')));
  }));

app.post('/api/ghosts', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<SpawnBody>(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const requestedProvider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined;

    if (!name) {
      throw new ApiError(400, 'Missing name');
    }

    const config = await getConfig() as LegacyConfig;
    const modelInput = requestedModel || config.defaultModel;
    const parsedModel = parseProviderAndModel(modelInput);

    if (!parsedModel.model) {
      throw new ApiError(400, 'Model is required.');
    }

    if (parsedModel.provider && requestedProvider && parsedModel.provider !== requestedProvider) {
      throw new ApiError(
        400,
        `Provider mismatch: model uses "${parsedModel.provider}" but provider was "${requestedProvider}".`,
      );
    }

    const provider = parsedModel.provider ?? (requestedProvider || getDefaultProvider(config));
    await spawnGhost(name, provider, parsedModel.model, systemPrompt);

    return c.json(await getGhost(name), 201);
  }));

app.post('/api/ghosts/:name/kill', (c) =>
  handleRoute(c, async () => {
    await killGhost(c.req.param('name'));
    return c.json({ status: 'killed' });
  }));

app.post('/api/ghosts/:name/wake', (c) =>
  handleRoute(c, async () => {
    await wakeGhost(c.req.param('name'));
    return c.json({ status: 'running' });
  }));

app.delete('/api/ghosts/:name', (c) =>
  handleRoute(c, async () => {
    await removeGhost(c.req.param('name'));
    return c.json({ status: 'removed' });
  }));

app.get('/api/ghosts/:name/health', (c) =>
  handleRoute(c, async () => {
    return c.json({ healthy: await getGhostHealth(c.req.param('name')) });
  }));

app.get('/api/ghosts/:name/history', (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostHistory(c.req.param('name')));
  }));

app.get('/api/ghosts/:name/stats', (c) =>
  handleRoute(c, async () => {
    return c.json(await getGhostStats(c.req.param('name')));
  }));

app.post('/api/ghosts/:name/message', async (c) => {
  try {
    const name = c.req.param('name');
    const body = await parseJsonBody<MessageBody>(c);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const modelValue = typeof body.model === 'string' ? body.model.trim() : '';
    const model = modelValue || undefined;
    const images = normalizeGhostImages(body.images);
    const ghost = await getGhost(name);

    if (!prompt) {
      throw new ApiError(400, 'Missing prompt');
    }

    if (ghost.status !== 'running') {
      throw new ApiError(409, `Ghost "${name}" is not running.`);
    }

    const messages = sendMessage(name, prompt, model, images);

    return streamSSE(
      c,
      async (stream) => {
        try {
          for await (const message of messages) {
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify(message),
            });
          }

          await stream.writeSSE({ event: 'done', data: '' });
        } catch (streamError) {
          log.error({ err: streamError, method: c.req.method, path: c.req.path }, 'SSE stream failed');
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: getErrorMessage(streamError) }),
          });
          await stream.writeSSE({ event: 'done', data: '' });
        }
      },
      async (error) => {
        log.error({ err: error, method: c.req.method, path: c.req.path }, 'SSE stream aborted');
      },
    );
  } catch (error) {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error);

    log.error(
      { err: error, method: c.req.method, path: c.req.path, status },
      'API request failed',
    );

    return c.json({ error: message }, { status });
  }
});

app.get('/api/ghosts/:name/keys', (c) =>
  handleRoute(c, async () => {
    return c.json(await listApiKeys(c.req.param('name')));
  }));

app.post('/api/ghosts/:name/keys', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<GenerateKeyBody>(c);
    const label = typeof body.label === 'string' ? body.label.trim() : '';

    if (!label) {
      throw new ApiError(400, 'Missing label');
    }

    return c.json(await generateApiKey(c.req.param('name'), label), 201);
  }));

app.delete('/api/ghosts/:name/keys/:keyId', (c) =>
  handleRoute(c, async () => {
    await revokeApiKey(c.req.param('name'), c.req.param('keyId'));
    return c.json({ status: 'revoked' });
  }));

app.post('/api/ghosts/:name/save', (c) =>
  handleRoute(c, async () => {
    return c.json({ commitHash: await commitVault(c.req.param('name')) });
  }));

app.get('/api/ghosts/:name/vault', (c) =>
  handleRoute(c, async () => {
    try {
      const { vaultPath, fullPath } = await resolveVaultItemPath(
        c.req.param('name'),
        c.req.query('path'),
        { allowRoot: true },
      );
      const directoryStats = await stat(fullPath);

      if (!directoryStats.isDirectory()) {
        throw new ApiError(400, 'Path must be a directory');
      }

      return c.json({ entries: await readVaultEntries(vaultPath, fullPath) });
    } catch (error) {
      return throwVaultFsError(error);
    }
  }));

app.get('/api/ghosts/:name/vault/read', (c) =>
  handleRoute(c, async () => {
    try {
      const { fullPath, apiPath } = await resolveVaultItemPath(
        c.req.param('name'),
        c.req.query('path'),
      );
      const fileStats = await stat(fullPath);

      if (!fileStats.isFile()) {
        throw new ApiError(400, 'Path must be a file');
      }

      return c.json({
        path: apiPath,
        content: await readFile(fullPath, 'utf8'),
        size: fileStats.size,
      });
    } catch (error) {
      return throwVaultFsError(error);
    }
  }));

app.put('/api/ghosts/:name/vault/write', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultWriteBody>(c);
    const inputPath = typeof body.path === 'string' ? body.path : undefined;
    const content = typeof body.content === 'string' ? body.content : null;

    if (content === null) {
      throw new ApiError(400, 'Missing content');
    }

    const { fullPath, apiPath } = await resolveVaultItemPath(c.req.param('name'), inputPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
    const fileStats = await stat(fullPath);

    return c.json({
      path: apiPath,
      size: fileStats.size,
    });
  }));

app.delete('/api/ghosts/:name/vault/delete', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<VaultDeleteBody>(c);
    const inputPath = typeof body.path === 'string' ? body.path : undefined;

    try {
      const { fullPath, apiPath } = await resolveVaultItemPath(c.req.param('name'), inputPath);
      const fileStats = await stat(fullPath);

      if (!fileStats.isFile()) {
        throw new ApiError(400, 'Path must be a file');
      }

      const trash = Bun.spawn(['trash', fullPath], {
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

      return c.json({ path: apiPath, status: 'deleted' as const });
    } catch (error) {
      return throwVaultFsError(error);
    }
  }));

app.post('/api/ghosts/:name/merge', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<MergeBody>(c);
    const target = typeof body.target === 'string' ? body.target.trim() : '';

    if (!target) {
      throw new ApiError(400, 'Missing target');
    }

    return c.json({ result: await mergeGhosts(c.req.param('name'), target) });
  }));

app.get('/api/config', (c) =>
  handleRoute(c, async () => {
    return c.json(toConfigResponse(await getConfig()));
  }));

app.put('/api/config', (c) =>
  handleRoute(c, async () => {
    const body = await parseJsonBody<ConfigUpdateBody>(c);
    const state = await loadState();
    const nextConfig = { ...state.config };

    if ('defaultProvider' in body) {
      nextConfig.defaultProvider = normalizeRequiredConfigValue(body.defaultProvider, 'defaultProvider');
    }

    if ('defaultModel' in body) {
      nextConfig.defaultModel = normalizeRequiredConfigValue(body.defaultModel, 'defaultModel');
    }

    if ('imageName' in body) {
      nextConfig.imageName = normalizeRequiredConfigValue(body.imageName, 'imageName');
    }

    if ('githubRemote' in body) {
      nextConfig.githubRemote = normalizeNullableConfigValue(body.githubRemote, 'githubRemote');
    }

    if ('githubToken' in body) {
      const githubToken = normalizeSensitiveConfigValue(body.githubToken, 'githubToken');
      if (githubToken === null) {
        nextConfig.githubToken = null;
      } else if (typeof githubToken === 'string') {
        nextConfig.githubToken = githubToken;
      }
    }

    if ('telegramToken' in body) {
      const telegramToken = normalizeSensitiveConfigValue(body.telegramToken, 'telegramToken');
      if (telegramToken === null) {
        nextConfig.telegramToken = '';
      } else if (typeof telegramToken === 'string') {
        nextConfig.telegramToken = telegramToken;
      }
    }

    state.config = nextConfig;
    await saveState(state);

    return c.json(toConfigResponse(nextConfig));
  }));

app.post('/api/ghosts/:name/reload', (c) =>
  handleRoute(c, async () => {
    await reloadGhost(c.req.param('name'));
    return c.json({ status: 'reloaded' });
  }));

app.post('/api/ghosts/:name/compact', (c) =>
  handleRoute(c, async () => {
    await compactGhost(c.req.param('name'));
    return c.json({ status: 'compacted' });
  }));

app.post('/api/ghosts/:name/abort', (c) =>
  handleRoute(c, async () => {
    await abortGhost(c.req.param('name'));
    return c.json({ status: 'aborted' });
  }));

app.post('/api/ghosts/:name/new', (c) =>
  handleRoute(c, async () => {
    await newGhostSession(c.req.param('name'));
    return c.json({ status: 'new_session' });
  }));

app.notFound((c) => c.json({ error: 'Not found' }, { status: 404 }));

if (import.meta.main) {
  Bun.serve({
    port,
    fetch: app.fetch,
  });

  log.info({ port }, 'API server listening');
}

export default app;
