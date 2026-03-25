import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  computeImageVersion,
  getNextPortBase,
  getStatePath,
  loadState,
  saveState,
} from '../../src/orchestrator';
import { createGhostState, createState, createTestHome } from '../support/test-state';

type TestHome = Awaited<ReturnType<typeof createTestHome>>;

describe('orchestrator helpers', () => {
  let testHome: TestHome;

  beforeEach(async () => {
    testHome = await createTestHome();
  });

  afterEach(async () => {
    await testHome.cleanup();
  });

  test('getStatePath follows the active HOME directory', () => {
    expect(getStatePath()).toBe(join(testHome.homeDir, '.ghostbox', 'state.json'));
  });

  test('getNextPortBase starts at 3100 and skips used port ranges', () => {
    expect(getNextPortBase(createState())).toBe(3100);

    const nextPort = getNextPortBase(
      createState({
        ghosts: {
          alpha: createGhostState({ portBase: 3100 }),
          beta: createGhostState({ portBase: 3110 }),
          gamma: createGhostState({ portBase: 3130 }),
        },
      }),
    );

    expect(nextPort).toBe(3120);
  });

  test('loadState normalizes missing imageVersion and apiKeys fields', async () => {
    await testHome.writeState({
      ghosts: {
        demo: {
          containerId: 'container-1',
          portBase: 3100,
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          status: 'running',
          createdAt: '2026-03-25T00:00:00.000Z',
          systemPrompt: null,
        },
      },
      config: {
        telegramToken: '',
        githubToken: null,
        githubRemote: null,
        defaultModel: 'anthropic/claude-sonnet-4-6',
        defaultProvider: 'anthropic',
        imageName: 'ghostbox-agent',
        observerModel: 'openai/gpt-4o-mini',
      },
      telegram: { activeChatGhosts: {} },
    });

    const state = await loadState();

    expect(state.config.imageVersion).toBe('');
    expect(state.ghosts.demo.imageVersion).toBe('');
    expect(state.ghosts.demo.apiKeys).toEqual([]);
  });

  test('saveState writes a state file that loadState can read back', async () => {
    const state = createState({
      ghosts: {
        demo: createGhostState(),
      },
    });

    await saveState(state);
    const reloaded = await loadState();

    expect(reloaded).toEqual(state);
  });

  test('computeImageVersion is stable for the same files and changes when content changes', async () => {
    const originalCwd = process.cwd();
    const dockerDir = join(testHome.homeDir, 'docker');
    const dockerFiles = [
      'ghost-server.js',
      'Dockerfile',
      'entrypoint.sh',
      'ghost-changelog',
      'ghost-memory',
      'qmd',
      'ghost-save',
      'exa-search',
    ];

    await mkdir(dockerDir, { recursive: true });
    for (const file of dockerFiles) {
      await writeFile(join(dockerDir, file), `${file}-v1\n`, 'utf8');
    }

    process.chdir(testHome.homeDir);

    try {
      const firstVersion = computeImageVersion('docker');
      const secondVersion = computeImageVersion('docker');

      expect(firstVersion).toMatch(/^gb-[0-9a-f]{8}$/);
      expect(secondVersion).toBe(firstVersion);

      await writeFile(join(dockerDir, 'qmd'), 'qmd-v2\n', 'utf8');

      const thirdVersion = computeImageVersion('docker');
      expect(thirdVersion).not.toBe(firstVersion);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
