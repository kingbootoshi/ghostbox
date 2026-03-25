import { describe, expect, mock, test } from 'bun:test';

import { createConfig, createGhostState, createState } from '../support/test-state';

const orchestratorModulePath = new URL('../../src/orchestrator.ts', import.meta.url).pathname;
const vaultModulePath = new URL('../../src/vault.ts', import.meta.url).pathname;
const loggerModulePath = new URL('../../src/logger.ts', import.meta.url).pathname;

const createAsyncGenerator = async function* () {
  return;
};

const createLoggerStub = () => ({
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
});

const loadMockedApi = async (overrides: Record<string, unknown> = {}) => {
  const orchestratorMocks = {
    abortGhost: mock(async () => undefined),
    clearGhostQueue: mock(async () => ({ cleared: { steering: [], followUp: [] } })),
    compactGhost: mock(async () => undefined),
    generateApiKey: mock(async () => ({
      id: 'key-1',
      key: 'gbox_1234567890abcdef',
      label: 'default',
      createdAt: '2026-03-25T00:00:00.000Z',
    })),
    getConfig: mock(async () => createConfig()),
    getGhost: mock(async () => createGhostState()),
    getGhostHealth: mock(async () => true),
    getGhostHistory: mock(async () => ({
      messages: [],
      preCompactionMessages: [],
      compactions: [],
    })),
    getGhostQueue: mock(async () => ({ steering: [], followUp: [], pendingCount: 0 })),
    getGhostStats: mock(async () => ({ tokens: 0 })),
    killGhost: mock(async () => undefined),
    listApiKeys: mock(async () => []),
    listGhosts: mock(async () => ({ demo: createGhostState() })),
    loadState: mock(async () => createState()),
    mergeGhosts: mock(async () => 'merged'),
    newGhostSession: mock(async () => undefined),
    reloadGhost: mock(async () => undefined),
    removeGhost: mock(async () => undefined),
    revokeApiKey: mock(async () => undefined),
    saveState: mock(async () => undefined),
    sendMessage: mock(() => createAsyncGenerator()),
    spawnGhost: mock(async () => undefined),
    steerGhost: mock(async () => ({ status: 'queued', pendingCount: 1 })),
    wakeGhost: mock(async () => undefined),
    ...overrides,
  };

  mock.module(orchestratorModulePath, () => orchestratorMocks);
  mock.module(vaultModulePath, () => ({
    commitVault: mock(async () => 'commit-1'),
    getVaultPath: mock((name: string) => `/tmp/${name}`),
  }));
  mock.module(loggerModulePath, () => ({
    createLogger: () => createLoggerStub(),
  }));

  const apiModule = await import(`../../src/api.ts?test=${crypto.randomUUID()}`);

  return {
    app: apiModule.default,
    orchestratorMocks,
  };
};

describe('api integration skeleton', () => {
  test('GET /api/ghosts can run against mocked orchestrator functions', async () => {
    const { app, orchestratorMocks } = await loadMockedApi({
      listGhosts: mock(async () => ({
        alpha: createGhostState({ portBase: 3100 }),
      })),
    });

    const response = await app.request('/api/ghosts');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alpha: createGhostState({ portBase: 3100 }),
    });
    expect(orchestratorMocks.listGhosts).toHaveBeenCalledTimes(1);
  });

  test('POST /api/ghosts can create a ghost through mocked orchestrator functions', async () => {
    const createdGhost = createGhostState({
      model: 'gpt-4.1',
      provider: 'openai',
    });
    const spawnGhost = mock(async () => undefined);
    const getGhost = mock(async () => createdGhost);
    const getConfig = mock(async () =>
      createConfig({
        defaultModel: 'openai/gpt-4.1',
        defaultProvider: 'openai',
      }),
    );

    const { app } = await loadMockedApi({
      spawnGhost,
      getGhost,
      getConfig,
    });

    const response = await app.request('/api/ghosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', model: 'openai/gpt-4.1' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(createdGhost);
    expect(spawnGhost).toHaveBeenCalledWith('alpha', 'openai', 'gpt-4.1', undefined);
    expect(getGhost).toHaveBeenCalledWith('alpha');
  });
});
