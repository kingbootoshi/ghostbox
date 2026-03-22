import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';

import { commitVault, pushVault } from './vault';
import {
  listGhosts,
  killGhost,
  loadState,
  mergeGhosts,
  saveState,
  sendMessage,
  spawnGhost,
  wakeGhost,
} from './orchestrator';
import { createLogger } from './logger';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TOOL_NOTIFICATION_INTERVAL_MS = 1000;
const log = createLogger('telegram');

type CommandArgs = string[];

const formatGhostTable = (ghosts: Record<string, { model: string; status: string; portBase: number }>): string => {
  const header = [
    'NAME'.padEnd(12),
    'MODEL'.padEnd(34),
    'STATUS'.padEnd(10),
    'PORTS',
  ].join('  ');

  const rows = Object.entries(ghosts).map(([name, ghost]) => {
    const ports = `${ghost.portBase}-${ghost.portBase + 9}`;
    return [
      name.padEnd(12),
      ghost.model.padEnd(34),
      ghost.status.padEnd(10),
      ports,
    ].join('  ');
  });

  if (rows.length === 0) {
    return `${header}\n${'No ghosts'.padEnd(12)}`;
  }

  return [header, ...rows].join('\n');
};

const parseCommandArgs = (text: string | undefined): CommandArgs => {
  if (!text) return [];
  return text.trim().split(/\s+/).filter(Boolean).slice(1);
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'Unknown error occurred.';
};

const getChatId = (ctx: { chat: { id: number } }): string => String(ctx.chat.id);

const splitMessage = (text: string): string[] => {
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += TELEGRAM_MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(index, index + TELEGRAM_MAX_MESSAGE_LENGTH));
  }
  return chunks;
};

const sendInChunks = async (ctx: { reply: (text: string) => Promise<unknown> }, text: string): Promise<void> => {
  const chunks = splitMessage(text);
  if (chunks.length === 0) {
    await ctx.reply('No response.');
    return;
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
};

const setActiveGhostForChat = async (
  chatId: string,
  ghostName: string,
): Promise<void> => {
  const state = await loadState();
  if (!state.ghosts[ghostName]) {
    throw new Error(`Ghost "${ghostName}" not found.`);
  }

  state.telegram.activeChatGhosts[chatId] = ghostName;
  await saveState(state);
};

const getActiveGhostForChat = async (chatId: string): Promise<string | null> => {
  const state = await loadState();
  return state.telegram.activeChatGhosts[chatId] ?? null;
};

export const startBot = async (token: string): Promise<void> => {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry());

  bot.command('start', async (ctx) => {
    const command = 'start';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    await ctx.reply(
      'Welcome to Ghostbox. Spawn persistent AI ghosts with /spawn and talk to them by selecting one with /talk.',
    );
  });

  bot.command('spawn', async (ctx) => {
    const command = 'spawn';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const ghostName = args[0];
      if (!ghostName) {
        await ctx.reply('Usage: /spawn <name> [model]');
        return;
      }

      const state = await loadState();
      const model = args[1] ?? state.config.defaultModel;
      await spawnGhost(
        ghostName,
        state.config.defaultProvider,
        model,
      );

      const updated = await loadState();
      const ghost = updated.ghosts[ghostName];
      if (!ghost) {
        await ctx.reply(`Spawned ${ghostName}.`);
        return;
      }

      await ctx.reply(`Ghost ${ghostName} is alive on port ${ghost.portBase}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to spawn ghost: ${formatError(error)}`);
    }
  });

  bot.command('list', async (ctx) => {
    const command = 'list';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const ghosts = await listGhosts();
      await ctx.reply(formatGhostTable(ghosts));
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to list ghosts: ${formatError(error)}`);
    }
  });

  bot.command(['talk', 'switch'], async (ctx) => {
    const commandText = ctx.message?.text?.trim().split(/\s+/)[0];
    const command = commandText ? commandText.replace(/^\//, '').split('@')[0] : 'talk';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const ghostName = args[0];
      if (!ghostName) {
        await ctx.reply('Usage: /talk <name>');
        return;
      }

      const chatId = getChatId(ctx);
      await setActiveGhostForChat(chatId, ghostName);
      await ctx.reply(`Now talking to ${ghostName}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to select ghost: ${formatError(error)}`);
    }
  });

  bot.command('kill', async (ctx) => {
    const command = 'kill';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const ghostName = args[0];
      if (!ghostName) {
        await ctx.reply('Usage: /kill <name>');
        return;
      }

      await killGhost(ghostName);
      await ctx.reply(`Killed ${ghostName}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to kill ghost: ${formatError(error)}`);
    }
  });

  bot.command('wake', async (ctx) => {
    const command = 'wake';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const ghostName = args[0];
      if (!ghostName) {
        await ctx.reply('Usage: /wake <name>');
        return;
      }

      await wakeGhost(ghostName);
      await ctx.reply(`Woke ${ghostName}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to wake ghost: ${formatError(error)}`);
    }
  });

  bot.command('save', async (ctx) => {
    const command = 'save';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const state = await loadState();
      const ghostName = args[0] || state.telegram.activeChatGhosts[chatId];

      if (!ghostName) {
        await ctx.reply('No active ghost. Use /talk <name> to pick one.');
        return;
      }

      const commitHash = await commitVault(ghostName);
      if (state.config.githubRemote && state.config.githubToken) {
        await pushVault(ghostName, state.config.githubRemote, state.config.githubToken);
      }

      if (!commitHash) {
        await ctx.reply(`No changes for ${ghostName}.`);
        return;
      }

      await ctx.reply(`Saved ${ghostName} at ${commitHash}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to save: ${formatError(error)}`);
    }
  });

  bot.command('merge', async (ctx) => {
    const command = 'merge';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const args = parseCommandArgs(ctx.message?.text);
      const source = args[0];
      const target = args[1];

      if (!source || !target) {
        await ctx.reply('Usage: /merge <source> <target>');
        return;
      }

      const result = await mergeGhosts(source, target);
      await ctx.reply(`Merge result: ${result}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to merge: ${formatError(error)}`);
    }
  });

  bot.command('status', async (ctx) => {
    const command = 'status';
    const chatId = getChatId(ctx);
    log.info({ command, chatId }, 'Command received');
    try {
      const state = await loadState();
      const active = state.telegram.activeChatGhosts[chatId];

      if (!active) {
        await ctx.reply('No active ghost.');
        return;
      }

      await ctx.reply(`Active ghost: ${active}`);
    } catch (error: unknown) {
      log.error({ err: error, command }, 'Command failed');
      await ctx.reply(`Failed to read status: ${formatError(error)}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!ctx.message.text || ctx.message.text.startsWith('/')) {
      return;
    }

    try {
      const chatId = getChatId(ctx);
      const activeGhost = await getActiveGhostForChat(chatId);
      if (!activeGhost) {
        await ctx.reply('No active ghost. Use /talk <name> to pick one.');
        return;
      }

      await ctx.replyWithChatAction('typing');
      let output = '';
      let lastToolSentAt = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const pendingTools: string[] = [];
      const waitForFlush = (ms: number): Promise<void> => {
        return new Promise((resolve) => {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            resolve();
          }, ms);
        });
      };
      const sendToolNotification = async (toolName: string): Promise<void> => {
        await ctx.reply(`[tool] ${toolName}`);
        lastToolSentAt = Date.now();
      };
      const flushPendingTools = async (): Promise<void> => {
        while (pendingTools.length > 0) {
          const elapsed = Date.now() - lastToolSentAt;
          if (lastToolSentAt !== 0 && elapsed < TOOL_NOTIFICATION_INTERVAL_MS) {
            await waitForFlush(TOOL_NOTIFICATION_INTERVAL_MS - elapsed);
          }

          const toolName = pendingTools.shift();
          if (!toolName) {
            continue;
          }

          await sendToolNotification(toolName);
        }
      };
      const stream = sendMessage(activeGhost, ctx.message.text);

      for await (const item of stream) {
        if (item.type === 'assistant') {
          output += item.text;
        }
        if (item.type === 'tool_use') {
          const elapsed = Date.now() - lastToolSentAt;
          if (
            pendingTools.length === 0 &&
            !flushTimer &&
            (lastToolSentAt === 0 || elapsed >= TOOL_NOTIFICATION_INTERVAL_MS)
          ) {
            await sendToolNotification(item.tool);
            continue;
          }

          pendingTools.push(item.tool);
          await flushPendingTools();
          continue;
        }
        if (item.type === 'result') {
          output += item.text;
          await flushPendingTools();
          await sendInChunks(ctx, output);
          return;
        }
      }

      await flushPendingTools();
      if (output.length > 0) {
        await sendInChunks(ctx, output);
      }
    } catch (error: unknown) {
      log.error({ err: error, command: 'message:text' }, 'Command failed');
      await ctx.reply(`Failed to send message: ${formatError(error)}`);
    }
  });

  bot.catch((error) => {
    log.error(
      {
        err: error.error,
        updateId: error.ctx.update.update_id,
        chatId: error.ctx.chat?.id,
      },
      'Unhandled Telegram bot error',
    );
  });

  await bot.start({
    onStart: () => {
      log.info('Telegram bot listening');
    },
  });
};

export const runBot = async (): Promise<void> => {
  const state = await loadState();
  await startBot(state.config.telegramToken);
};
