import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import app from '../../src/api';
import {
  createConfig,
  createGhostState,
  createState,
  createTestHome,
} from '../support/test-state';

type TestHome = Awaited<ReturnType<typeof createTestHome>>;

const postJson = (path: string, body: unknown): Promise<Response> => {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const putJson = (path: string, body: unknown): Promise<Response> => {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

describe('api route validation', () => {
  let testHome: TestHome;

  beforeEach(async () => {
    testHome = await createTestHome();
  });

  afterEach(async () => {
    await testHome.cleanup();
  });

  test('GET /api/config masks sensitive values and reports status flags', async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          githubToken: 'github-token-1234567890',
          telegramToken: 'telegram-token-1234567890',
        }),
      }),
    );

    const response = await app.request('/api/config');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      telegramToken: 'telegram-tok...7890',
      githubToken: 'github-token...7890',
      githubRemote: 'https://github.com/example/repo.git',
      defaultModel: 'anthropic/claude-sonnet-4-6',
      defaultProvider: 'anthropic',
      imageName: 'ghostbox-agent',
      imageVersion: 'gb-deadbeef',
      observerModel: 'openai/gpt-4o-mini',
      hasSensitive: {
        githubToken: true,
        telegramToken: true,
      },
    });
  });

  test('PUT /api/config trims values, clears nullable fields, and preserves masked secrets', async () => {
    await testHome.writeState(
      createState({
        config: createConfig({
          githubToken: 'github-token-1234567890',
          telegramToken: 'telegram-token-1234567890',
          githubRemote: 'https://github.com/example/repo.git',
        }),
      }),
    );

    const response = await putJson('/api/config', {
      defaultProvider: 'openai',
      defaultModel: ' openai/gpt-4.1 ',
      imageName: ' ghostbox-next ',
      githubRemote: '   ',
      githubToken: 'github-token...7890',
      telegramToken: null,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      telegramToken: '',
      githubToken: 'github-token...7890',
      githubRemote: null,
      defaultModel: 'openai/gpt-4.1',
      defaultProvider: 'openai',
      imageName: 'ghostbox-next',
      imageVersion: 'gb-deadbeef',
      observerModel: 'openai/gpt-4o-mini',
      hasSensitive: {
        githubToken: true,
        telegramToken: false,
      },
    });

    const savedState = JSON.parse(await Bun.file(testHome.statePath).text());
    expect(savedState.config.githubToken).toBe('github-token-1234567890');
    expect(savedState.config.telegramToken).toBe('');
    expect(savedState.config.githubRemote).toBeNull();
  });

  test('PUT /api/config rejects invalid JSON bodies', async () => {
    const response = await app.request('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  test('POST /api/ghosts rejects requests with a missing name', async () => {
    const response = await postJson('/api/ghosts', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing name' });
  });

  test('POST /api/ghosts rejects provider and model mismatches before spawning', async () => {
    const response = await postJson('/api/ghosts', {
      name: 'mismatch',
      provider: 'openai',
      model: 'anthropic/claude-sonnet-4-6',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Provider mismatch: model uses "anthropic" but provider was "openai".',
    });
  });

  test('POST /api/ghosts/:name/message rejects invalid streaming behavior', async () => {
    const response = await postJson('/api/ghosts/demo/message', {
      prompt: 'hello',
      streamingBehavior: 'invalid',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid streamingBehavior' });
  });

  test('POST /api/ghosts/:name/message rejects malformed image payloads', async () => {
    const response = await postJson('/api/ghosts/demo/message', {
      prompt: 'hello',
      images: [{ mediaType: 'image/png' }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid images' });
  });

  test('GET /api/ghosts/:name/vault/read rejects path traversal attempts', async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState(),
        },
      }),
    );

    const response = await app.request('/api/ghosts/demo/vault/read?path=../../secret.txt');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid path' });
  });

  test('GET /api/ghosts/:name/vault lists directories before files with API paths', async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState(),
        },
      }),
    );
    await testHome.createVaultFile('demo', 'notes/todo.md', 'todo');
    await testHome.createVaultFile('demo', 'README.md', 'hello');

    const response = await app.request('/api/ghosts/demo/vault');
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      name: 'notes',
      path: '/notes',
      type: 'directory',
    });
    expect(payload.entries[1]).toMatchObject({
      name: 'README.md',
      path: '/README.md',
      type: 'file',
      size: 5,
    });
  });

  test('GET /api/ghosts/:name/vault/read returns file contents and normalized path', async () => {
    await testHome.writeState(
      createState({
        ghosts: {
          demo: createGhostState(),
        },
      }),
    );
    await testHome.createVaultFile('demo', 'notes/todo.md', 'remember this');

    const response = await app.request('/api/ghosts/demo/vault/read?path=/notes/todo.md');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '/notes/todo.md',
      content: 'remember this',
      size: 13,
    });
  });
});
