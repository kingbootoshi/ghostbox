import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, mkdir } from 'node:fs/promises';

import { commitVault, pushVault } from './vault';
import {
  getConfig,
  generateApiKey,
  getStatePath,
  killGhost,
  listApiKeys,
  listGhosts,
  loadState,
  mergeGhosts,
  removeGhost,
  revokeApiKey,
  saveState,
  sendMessage,
  spawnGhost,
  upgradeGhosts,
  wakeGhost,
} from './orchestrator';
import type { GhostApiKey, GhostboxState, GhostState } from './types';
import { startBot } from './telegram';
import { createLogger } from './logger';

const DEFAULT_IMAGE_NAME = 'ghostbox-agent';
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.3-codex',
} as const;
const SUPPORTED_PROVIDERS = Object.keys(DEFAULT_MODEL_BY_PROVIDER);
const log = createLogger('cli');

type SpawnCommandOptions = {
  model?: string;
  provider?: string;
  prompt?: string;
};

const getHomeDirectory = (): string => process.env.HOME ?? homedir();
const getGhostboxDirectory = (): string => join(getHomeDirectory(), '.ghostbox');
const getPiAuthPath = (): string => join(getHomeDirectory(), '.pi', 'agent', 'auth.json');

export const prompt = async (question: string): Promise<string> => {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
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
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  return { exitCode, stdout, stderr };
};

const runCommandInherit = async (
  command: string,
  args: string[],
): Promise<void> => {
  const child = Bun.spawn([command, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
};

const requireStateDirectory = async (): Promise<void> => {
  const stateDirectory = getGhostboxDirectory();
  await mkdir(stateDirectory, { recursive: true });
};

const formatGhostTable = (
  ghosts: Record<string, GhostState>,
  currentImageVersion: string,
): string => {
  const header = [
    'NAME'.padEnd(12),
    'MODEL'.padEnd(34),
    'STATUS'.padEnd(10),
    'VERSION'.padEnd(28),
    'PORTS',
  ].join('  ');

  const rows = Object.entries(ghosts).map(([name, ghost]) => {
    const ports = `${ghost.portBase}-${ghost.portBase + 9}`;
    const version =
      ghost.imageVersion.length === 0
        ? ''
        : ghost.imageVersion === currentImageVersion
          ? `${ghost.imageVersion} (current)`
          : `${ghost.imageVersion} (stale)`;

    return [
      name.padEnd(12),
      ghost.model.padEnd(34),
      ghost.status.padEnd(10),
      version.padEnd(28),
      ports,
    ].join('  ');
  });

  if (rows.length === 0) {
    return `${header}\n${'No ghosts'.padEnd(12)}`;
  }

  return [header, ...rows].join('\n');
};

const formatApiKeyTable = (apiKeys: GhostApiKey[]): string => {
  const header = [
    'ID'.padEnd(10),
    'LABEL'.padEnd(20),
    'CREATED'.padEnd(26),
    'KEY',
  ].join('  ');

  const rows = apiKeys.map((apiKey) => {
    return [
      apiKey.id.padEnd(10),
      apiKey.label.padEnd(20),
      apiKey.createdAt.padEnd(26),
      apiKey.key,
    ].join('  ');
  });

  if (rows.length === 0) {
    return `${header}\n${'No keys'.padEnd(10)}`;
  }

  return [header, ...rows].join('\n');
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
  invalidMessage: string,
): Promise<string> => {
  while (true) {
    const value = await prompt(question);
    if (!value.length) {
      log.warn(chalk.red('Value is required.'));
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
  if (provider === 'openai') {
    return DEFAULT_MODEL_BY_PROVIDER.openai;
  }

  return DEFAULT_MODEL_BY_PROVIDER.anthropic;
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
    provider: normalizeProvider(trimmed.slice(0, separatorIndex)),
    model: trimmed.slice(separatorIndex + 1).trim(),
  };
};

const getStoredProviderAndModel = (
  config: { defaultModel?: string; defaultProvider?: string | null },
): { provider: string; model: string } => {
  const parsed = config.defaultModel ? parseProviderAndModel(config.defaultModel) : null;
  const provider = normalizeProvider(
    config.defaultProvider && config.defaultProvider.length > 0
      ? config.defaultProvider
      : parsed?.provider ?? DEFAULT_PROVIDER,
  );

  return {
    provider: isSupportedProvider(provider) ? provider : DEFAULT_PROVIDER,
    model: parsed?.model && parsed.model.length > 0
      ? parsed.model
      : getDefaultModelForProvider(
          isSupportedProvider(provider) ? provider : DEFAULT_PROVIDER,
        ),
  };
};

const ensurePiAuthExists = async (): Promise<void> => {
  try {
    await access(getPiAuthPath());
  } catch {
    throw new Error('Pi agent auth not found. Run "pi" and login first.');
  }
};

const promptForProvider = async (defaultProvider: string): Promise<string> => {
  while (true) {
    const providerInput = await prompt(
      `Default provider [anthropic/openai] (${defaultProvider}): `,
    );
    const provider = normalizeProvider(providerInput || defaultProvider);

    if (isSupportedProvider(provider)) {
      return provider;
    }

    log.warn(chalk.red('Provider must be "anthropic" or "openai".'));
  }
};

const resolveConfiguredModel = (value: string, fallbackModel: string): string => {
  const selected = value.length > 0 ? value : fallbackModel;
  return parseProviderAndModel(selected).model;
};

const parseSpawnFlags = (args: string[]): {
  name: string;
  options: SpawnCommandOptions;
} => {
  if (args.length === 0) {
    throw new Error(
      'Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]',
    );
  }

  const result: { name: string; options: SpawnCommandOptions } = {
    name: '',
    options: {},
  };
  let nameSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--model') {
      const model = args[index + 1];
      if (!model) {
        throw new Error(
          'Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]',
        );
      }
      result.options.model = model;
      index += 1;
      continue;
    }

    if (arg === '--provider') {
      const provider = args[index + 1];
      if (!provider) {
        throw new Error(
          'Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]',
        );
      }
      result.options.provider = provider;
      index += 1;
      continue;
    }

    if (arg === '--prompt') {
      const promptText = args[index + 1];
      if (!promptText) {
        throw new Error(
          'Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]',
        );
      }
      result.options.prompt = promptText;
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
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
    throw new Error(
      'Usage: ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]',
    );
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
  log.info(chalk.cyan('Usage:'));
  log.info('  ghostbox init');
  log.info('  ghostbox spawn <name> [--model <model>] [--provider <provider>] [--prompt <text>]');
  log.info('  ghostbox list');
  log.info('  ghostbox upgrade');
  log.info('  ghostbox talk <name> <message>');
  log.info('  ghostbox kill <name>');
  log.info('  ghostbox wake <name>');
  log.info('  ghostbox save <name>');
  log.info('  ghostbox merge <source> <target>');
  log.info('  ghostbox logs <name>');
  log.info('  ghostbox rm <name>');
  log.info('  ghostbox keys <name>');
  log.info('  ghostbox keys generate <name> [label]');
  log.info('  ghostbox keys revoke <name> <keyId>');
  log.info('  ghostbox bot');
};

const init = async (): Promise<void> => {
  const dockerCheck = await runCommandCapture('docker', ['info']);
  if (dockerCheck.exitCode !== 0) {
    throw new Error(`Docker is not available: ${dockerCheck.stderr || dockerCheck.stdout}`);
  }

  const gitCheck = await runCommandCapture('git', ['--version']);
  if (gitCheck.exitCode !== 0) {
    throw new Error(`Git is not available: ${gitCheck.stderr || gitCheck.stdout}`);
  }

  await ensurePiAuthExists();

  const existingState = await loadExistingState();
  const existingConfig =
    existingState?.config as (GhostboxState['config'] & { defaultProvider?: string | null }) | undefined;
  const canReuseState =
    existingState !== null &&
    existingState.config?.defaultModel &&
    existingState.config.defaultModel.length > 0;

  let telegramToken: string;
  let githubToken: string | null;
  let githubRemote: string | null;
  let defaultProvider: string;
  let defaultModel: string;

  if (canReuseState) {
    const storedDefaults = getStoredProviderAndModel({
      defaultModel: existingState.config.defaultModel,
      defaultProvider: existingConfig?.defaultProvider ?? null,
    });
    const githubConfigured = Boolean(
      existingState.config.githubRemote && existingState.config.githubToken,
    );
    const reuseInput = await prompt(
      chalk.cyan(
        `Re-use existing config? (provider: ${storedDefaults.provider}, model: ${storedDefaults.model}, github: ${githubConfigured ? 'configured' : 'not configured'}) [y/N]: `,
      ),
    );
    if (reuseInput === 'y' || reuseInput === 'Y') {
      telegramToken = existingState.config.telegramToken;
      githubToken = existingState.config.githubToken;
      githubRemote = existingState.config.githubRemote;
      defaultProvider = storedDefaults.provider;
      defaultModel = storedDefaults.model;
    } else {
      telegramToken = await getRequiredInput(
        'Telegram bot token: ',
        isTelegramTokenValid,
        'Invalid Telegram token.',
      );

      const githubTokenInput = await prompt('GitHub token (optional): ');
      githubToken = githubTokenInput.length > 0 ? githubTokenInput : null;

      const githubRemoteInput = await prompt('GitHub remote URL (optional): ');
      githubRemote = githubToken && githubRemoteInput.length > 0 ? githubRemoteInput : null;

      defaultProvider = await promptForProvider(DEFAULT_PROVIDER);
      const defaultProviderModel = getDefaultModelForProvider(defaultProvider);
      const modelInput = await prompt(`Default model [${defaultProviderModel}]: `);
      defaultModel = resolveConfiguredModel(modelInput, defaultProviderModel);
    }
  } else {
    telegramToken = await getRequiredInput(
      'Telegram bot token: ',
      isTelegramTokenValid,
      'Invalid Telegram token.',
    );

    const githubTokenInput = await prompt('GitHub token (optional): ');
    githubToken = githubTokenInput.length > 0 ? githubTokenInput : null;

    const githubRemoteInput = await prompt('GitHub remote URL (optional): ');
    githubRemote = githubToken && githubRemoteInput.length > 0 ? githubRemoteInput : null;

    defaultProvider = await promptForProvider(DEFAULT_PROVIDER);
    const defaultProviderModel = getDefaultModelForProvider(defaultProvider);
    const modelInput = await prompt(`Default model [${defaultProviderModel}]: `);
    defaultModel = resolveConfiguredModel(modelInput, defaultProviderModel);
  }

  await requireStateDirectory();
  const state = {
    ghosts: existingState?.ghosts ?? {},
    config: {
      githubRemote,
      githubToken,
      telegramToken,
      defaultProvider,
      defaultModel,
      imageName: existingState?.config?.imageName ?? DEFAULT_IMAGE_NAME,
      imageVersion: existingState?.config?.imageVersion ?? '',
      observerModel: existingState?.config?.observerModel ?? '',
    },
    telegram: existingState?.telegram ?? { activeChatGhosts: {} },
  } as unknown as GhostboxState;
  await saveState(state);

  await runCommandInherit(
    'bun',
    [
      'build',
      'src/ghost-server.ts',
      '--target=node',
      '--outfile=docker/ghost-server.js',
      '--external',
      '@mariozechner/pi-coding-agent',
    ],
  );

  await runCommandInherit('docker', ['build', '-t', DEFAULT_IMAGE_NAME, 'docker/']);

  const { computeImageVersion } = await import('./orchestrator');
  const imageVersion = computeImageVersion('docker/');
  const refreshedState = await loadState();
  refreshedState.config.imageVersion = imageVersion;
  await saveState(refreshedState);
  log.info(`Image version: ${imageVersion}`);

  log.info(chalk.green('Ghostbox initialized.'));
  log.info('config:');
  log.info(`  provider: ${defaultProvider}`);
  log.info(`  model: ${defaultModel}`);
  log.info(`  state path: ${getStatePath()}`);
  log.info('  telegram: configured');
  log.info(`  github: ${githubRemote ? 'configured' : 'not configured'}`);
};

const spawn = async (name: string, options: SpawnCommandOptions): Promise<void> => {
  const state = await loadState();
  const config =
    state.config as GhostboxState['config'] & { defaultProvider?: string | null };
  const storedDefaults = getStoredProviderAndModel({
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider ?? null,
  });
  const parsedModel = options.model
    ? parseProviderAndModel(options.model)
    : { provider: null, model: storedDefaults.model };
  const defaultProvider = storedDefaults.provider;
  const providerInput = options.provider ? normalizeProvider(options.provider) : null;

  if (parsedModel.provider && providerInput && parsedModel.provider !== providerInput) {
    throw new Error(
      `Provider mismatch: model uses "${parsedModel.provider}" but --provider was "${providerInput}".`,
    );
  }

  const provider = parsedModel.provider ?? providerInput ?? defaultProvider;
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  if (!parsedModel.model) {
    throw new Error('Model is required.');
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

  await runCommandInherit(
    'bun',
    [
      'build',
      'src/ghost-server.ts',
      '--target=node',
      '--outfile=docker/ghost-server.js',
      '--external',
      '@mariozechner/pi-coding-agent',
    ],
  );

  await runCommandInherit('docker', ['build', '-t', imageName, 'docker/']);

  const result = await upgradeGhosts('docker/');
  log.info(
    `Upgraded: ${result.upgraded.length}, Skipped: ${result.skipped.length}, Failed: ${result.failed.length}`,
  );
};

const keys = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    throw new Error(
      'Usage: ghostbox keys <name> | ghostbox keys generate <name> [label] | ghostbox keys revoke <name> <keyId>',
    );
  }

  if (args[0] === 'generate') {
    const name = args[1];
    const label = args[2] ?? 'default';

    if (!name) {
      throw new Error('Usage: ghostbox keys generate <name> [label]');
    }

    const apiKey = await generateApiKey(name, label);
    log.info(chalk.green(`Created API key ${apiKey.id} for ${name}.`));
    log.info(`Label: ${apiKey.label}`);
    log.info(`Key: ${apiKey.key}`);
    log.warn(chalk.yellow('Save this key - it will not be shown again'));
    return;
  }

  if (args[0] === 'revoke') {
    const name = args[1];
    const keyId = args[2];

    if (!name || !keyId) {
      throw new Error('Usage: ghostbox keys revoke <name> <keyId>');
    }

    await revokeApiKey(name, keyId);
    log.info(chalk.green(`Revoked API key ${keyId} for ${name}.`));
    return;
  }

  if (args.length > 1) {
    throw new Error('Usage: ghostbox keys <name>');
  }

  const apiKeys = await listApiKeys(args[0]);
  log.info(formatApiKeyTable(apiKeys));
};

const talk = async (name: string, message: string): Promise<void> => {
  const messages = sendMessage(name, message);
  for await (const item of messages) {
    if (item.type === 'assistant') {
      process.stdout.write(`${item.text}\n`);
      continue;
    }
    if (item.type === 'tool_use') {
      process.stdout.write(`[tool] ${item.tool}\n`);
      continue;
    }
    if (item.type === 'result') {
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
  log.info(chalk.green('Merge result:'));
  log.info(result);
};

const logs = async (name: string): Promise<void> => {
  const state = await loadState();
  const ghost = state.ghosts[name];
  if (!ghost) {
    throw new Error(`Ghost "${name}" not found.`);
  }

  const child = Bun.spawn(['docker', 'logs', '-f', ghost.containerId], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`docker logs failed with exit code ${exitCode}`);
  }
};

const bot = async (): Promise<void> => {
  const state = await loadState();
  log.info('Running bot pre-flight checks');

  const dockerCheck = await runCommandCapture('docker', ['info']);
  if (dockerCheck.exitCode !== 0) {
    log.error(
      {
        stdout: dockerCheck.stdout.trim(),
        stderr: dockerCheck.stderr.trim(),
      },
      'Docker is not reachable',
    );
    throw new Error('Docker is not available.');
  }
  log.info('Docker is reachable');

  const isTokenValid = await isTelegramTokenValid(state.config.telegramToken);
  if (!isTokenValid) {
    log.error('Telegram token is invalid');
    throw new Error('Invalid Telegram token.');
  }
  log.info('Telegram token is valid');

  log.info('Starting Ghostbox bot...');
  await startBot(state.config.telegramToken);
};

const main = async (): Promise<void> => {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case 'init':
        await init();
        break;
      case 'spawn': {
        const parsed = parseSpawnFlags(args);
        await spawn(parsed.name, parsed.options);
        break;
      }
      case 'list':
        await list();
        break;
      case 'upgrade':
        await upgrade();
        break;
      case 'talk': {
        const [name, ...messageParts] = args;
        if (!name || messageParts.length === 0) {
          throw new Error('Usage: ghostbox talk <name> <message>');
        }
        await talk(name, messageParts.join(' '));
        break;
      }
      case 'kill':
        if (!args[0]) {
          throw new Error('Usage: ghostbox kill <name>');
        }
        await killGhost(args[0]);
        log.info(chalk.green(`Killed ${args[0]}`));
        break;
      case 'wake':
        if (!args[0]) {
          throw new Error('Usage: ghostbox wake <name>');
        }
        await wakeGhost(args[0]);
        log.info(chalk.green(`Woke ${args[0]}`));
        break;
      case 'save':
        if (!args[0]) {
          throw new Error('Usage: ghostbox save <name>');
        }
        await save(args[0]);
        break;
      case 'merge':
        if (!args[0] || !args[1]) {
          throw new Error('Usage: ghostbox merge <source> <target>');
        }
        await merge(args[0], args[1]);
        break;
      case 'logs':
        if (!args[0]) {
          throw new Error('Usage: ghostbox logs <name>');
        }
        await logs(args[0]);
        break;
      case 'rm':
        if (!args[0]) {
          throw new Error('Usage: ghostbox rm <name>');
        }
        await removeGhost(args[0]);
        log.info(chalk.green(`Removed ${args[0]}`));
        break;
      case 'keys':
        await keys(args);
        break;
      case 'bot':
        await bot();
        break;
      default:
        printUsage();
        process.exitCode = 1;
        return;
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error occurred.';
    log.error(chalk.red(message));
    process.exitCode = 1;
    return;
  }

  if (command === 'bot') {
    return;
  }
};

main();
