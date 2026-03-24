import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AuthStorage,
  codingTools,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { GhostMessage, HistoryMessage } from './types';

const defaultSystemPrompt =
  'You are a ghost agent. Your vault at /vault is your persistent memory. Write important findings to /vault/knowledge/. Keep /vault/CLAUDE.md updated. Create tools in /vault/code/tools/. Everything in /vault persists across sessions. The rest of the filesystem is throwaway.';

type LogContext = Record<string, unknown>;

type TextBlock = {
  type?: string;
  text?: string;
};

type PiModel = {
  provider: string;
  id: string;
};

type PiAgentMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  toolName?: string;
};

type PiAgentEvent = {
  type: string;
  message?: PiAgentMessage;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  messages?: unknown[];
};

type SlashCommandHandler = (
  res: ServerResponse,
  args: string,
) => Promise<void> | void;

type SlashCommand = {
  name: string;
  description: string;
  handler: SlashCommandHandler;
};

const isMessageUpdateEvent = (event: PiAgentEvent): boolean => event.type === 'message_update';

const isMessageEndEvent = (event: PiAgentEvent): boolean => event.type === 'message_end';

const isToolExecutionStartEvent = (event: PiAgentEvent): boolean =>
  event.type === 'tool_execution_start';

const isToolExecutionEndEvent = (event: PiAgentEvent): boolean =>
  event.type === 'tool_execution_end';

const isAgentEndEvent = (event: PiAgentEvent): boolean => event.type === 'agent_end';

const formatContext = (context?: LogContext): string => {
  if (!context) return '';

  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ' {"context":"unserializable"}';
  }
};

const serializeError = (error: unknown): LogContext => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? '',
    };
  }

  return { error };
};

const parseApiKeys = (value: string | undefined): string[] => {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('GHOSTBOX_API_KEYS must be a JSON array of strings');
  }

  return parsed;
};

const log = {
  info: (message: string, context?: LogContext): void => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [ghost-server] INFO ${message}${formatContext(context)}`);
  },
  error: (message: string, context?: LogContext): void => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ghost-server] ERROR ${message}${formatContext(context)}`);
  },
};

const sendJsonLine = (res: ServerResponse, payload: GhostMessage): void => {
  res.write(`${JSON.stringify(payload)}\n`);
};

const startNdjsonResponse = (res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
};

const sendAssistantResult = (
  res: ServerResponse,
  text: string,
  options?: { end?: boolean },
): void => {
  sendJsonLine(res, {
    type: 'assistant',
    text,
  });

  sendJsonLine(res, {
    type: 'result',
    text: '',
    sessionId: session.sessionId,
  });

  if (options?.end !== false) {
    res.end();
  }
};

const getRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const getAssistantText = (content: unknown): string => {
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const candidate = block as TextBlock;
      if (candidate.type !== 'text' || typeof candidate.text !== 'string') return '';
      return candidate.text;
    })
    .join('');
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const summarizeValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getContentText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  return getAssistantText(content);
};

const getContentSummary = (content: unknown): string => {
  const text = getContentText(content);
  if (text) {
    return text;
  }

  return summarizeValue(content);
};

const getMessageTimestamp = (message: PiAgentMessage): string | undefined => {
  const { timestamp } = message;

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(timestamp);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return timestamp;
};

const createHistoryMessage = (
  role: HistoryMessage['role'],
  text: string,
  options?: { allowEmptyText?: boolean; toolName?: string; timestamp?: string },
): HistoryMessage | null => {
  const trimmedText = text.trim();
  if (!trimmedText && options?.allowEmptyText !== true) {
    return null;
  }

  return {
    role,
    text: trimmedText,
    ...(options?.toolName ? { toolName: options.toolName } : {}),
    ...(options?.timestamp ? { timestamp: options.timestamp } : {}),
  };
};

const getHistoryMessages = (messages: PiAgentMessage[]): HistoryMessage[] => {
  return messages.flatMap((message) => {
    const timestamp = getMessageTimestamp(message);
    const toolName = typeof message.toolName === 'string' ? message.toolName : undefined;

    if (message.role === 'user' || message.role === 'system') {
      const historyMessage = createHistoryMessage(message.role, getContentText(message.content), {
        timestamp,
      });
      return historyMessage ? [historyMessage] : [];
    }

    if (message.role === 'assistant') {
      const historyMessages: HistoryMessage[] = [];
      const assistantMessage = createHistoryMessage(
        'assistant',
        getContentText(message.content),
        { timestamp },
      );

      if (assistantMessage) {
        historyMessages.push(assistantMessage);
      }

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== 'toolCall') {
            continue;
          }

          const toolUseMessage = createHistoryMessage(
            'tool_use',
            summarizeValue(block.arguments),
            {
              allowEmptyText: true,
              toolName: typeof block.name === 'string' ? block.name : undefined,
              timestamp,
            },
          );

          if (toolUseMessage) {
            historyMessages.push(toolUseMessage);
          }
        }
      }

      return historyMessages;
    }

    if (message.role === 'toolResult' || message.role === 'tool_result') {
      const historyMessage = createHistoryMessage(
        'tool_result',
        getContentSummary(message.content),
        { allowEmptyText: true, toolName, timestamp },
      );
      return historyMessage ? [historyMessage] : [];
    }

    if (message.role === 'toolUse' || message.role === 'tool_use') {
      const historyMessage = createHistoryMessage(
        'tool_use',
        getContentSummary(message.content),
        { allowEmptyText: true, toolName, timestamp },
      );
      return historyMessage ? [historyMessage] : [];
    }

    return [];
  });
};

const parseSlashCommandPrompt = (prompt: string): { command: string; args: string } | null => {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstSpaceIndex = trimmed.indexOf(' ');
  const rawCommand =
    firstSpaceIndex === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, firstSpaceIndex);
  const command = rawCommand.trim().toLowerCase();

  if (!command) {
    return null;
  }

  return {
    command,
    args: firstSpaceIndex === -1 ? '' : trimmed.slice(firstSpaceIndex + 1).trim(),
  };
};

const parseModelRef = (value: string): { provider: string; modelId: string } => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(`Invalid model format: ${value}`);
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
};

const resolveModel = (modelRegistry: ModelRegistry, value: string): PiModel => {
  const { provider, modelId } = parseModelRef(value);
  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }

  return model;
};

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const systemPrompt = process.env.GHOSTBOX_SYSTEM_PROMPT || defaultSystemPrompt;
const startupModelValue = process.env.GHOSTBOX_MODEL;
const configuredApiKeys = parseApiKeys(process.env.GHOSTBOX_API_KEYS);
const startupModel = startupModelValue
  ? resolveModel(modelRegistry, startupModelValue)
  : undefined;

const sessionManagerCandidate = SessionManager.continueRecent('/vault');
const sessionManager = sessionManagerCandidate.getSessionFile()
  ? sessionManagerCandidate
  : SessionManager.create('/vault');
const resumedSession = Boolean(sessionManagerCandidate.getSessionFile());

const resourceLoader = new DefaultResourceLoader({
  cwd: '/vault',
  systemPromptOverride: () => systemPrompt,
  appendSystemPromptOverride: () => [],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: '/vault',
  sessionManager,
  model: startupModel,
  authStorage,
  modelRegistry,
  tools: codingTools,
  resourceLoader,
});

log.info('Pi session ready', {
  sessionId: session.sessionId,
  resumed: resumedSession,
  model: startupModelValue ?? 'default',
  apiKeyCount: configuredApiKeys.length,
});

let currentModelValue = startupModelValue ?? 'default';

let requestQueue: Promise<void> = Promise.resolve();

const runQueued = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = requestQueue.catch(() => undefined).then(task);
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const streamPrompt = async (
  res: ServerResponse,
  prompt: string,
  modelValue?: string,
): Promise<void> => {
  startNdjsonResponse(res);

  if (modelValue) {
    const nextModel = resolveModel(session.modelRegistry, modelValue);
    await session.setModel(nextModel);
    currentModelValue = `${nextModel.provider}/${nextModel.id}`;
    log.info('Pi model switched', { model: `${nextModel.provider}/${nextModel.id}` });
  }

  let currentAssistantText = '';
  let lastAssistantText = '';
  let unsubscribe = (): void => {};

  const completion = new Promise<void>((resolve, reject) => {
    unsubscribe = session.subscribe((rawEvent) => {
      const event = rawEvent as PiAgentEvent;

      try {
        const assistantMessageEvent = event.assistantMessageEvent;

        if (
          isMessageUpdateEvent(event) &&
          assistantMessageEvent?.type === 'text_delta' &&
          typeof assistantMessageEvent.delta === 'string'
        ) {
          currentAssistantText += assistantMessageEvent.delta;
          return;
        }

        if (isMessageEndEvent(event) && event.message?.role === 'assistant') {
          const fullText = currentAssistantText || getAssistantText(event.message.content);
          if (fullText) {
            lastAssistantText = fullText;
            log.info('SDK assistant', {
              chars: fullText.length,
              preview: fullText.slice(0, 200),
            });
            sendJsonLine(res, {
              type: 'assistant',
              text: fullText,
            });
          }
          currentAssistantText = '';
          return;
        }

        if (isToolExecutionStartEvent(event) && typeof event.toolName === 'string') {
          log.info('SDK tool_use', { tool: event.toolName });
          sendJsonLine(res, {
            type: 'tool_use',
            tool: event.toolName,
            input: event.args ?? null,
          });
          return;
        }

        if (isToolExecutionEndEvent(event)) {
          const preview =
            typeof event.result === 'string' ? event.result.slice(0, 200) : '';
          log.info('SDK tool_result', { preview, isError: event.isError });
          sendJsonLine(res, {
            type: 'tool_result',
            output: event.result ?? null,
          });
          return;
        }

        if (isAgentEndEvent(event)) {
          log.info('SDK result', { sessionId: session.sessionId });
          sendJsonLine(res, {
            type: 'result',
            text: '',
            sessionId: session.sessionId,
          });
          unsubscribe();
          resolve();
        }
      } catch (error) {
        unsubscribe();
        reject(error);
      }
    });
  });

  try {
    log.info('Pi prompt start', {
      sessionId: session.sessionId,
      chars: prompt.length,
      preview: prompt.slice(0, 200),
    });
    await session.prompt(prompt);
    await completion;
  } catch (error) {
    unsubscribe();
    log.error('Message processing failed', serializeError(error));
    sendJsonLine(res, {
      type: 'result',
      text: 'Ghost server failed while processing message.',
      sessionId: session.sessionId,
    });
  } finally {
    unsubscribe();
    res.end();
  }
};

const slashCommands = new Map<string, SlashCommand>();

const registerSlashCommand = (command: SlashCommand): void => {
  const key = command.name.startsWith('/') ? command.name.slice(1) : command.name;
  slashCommands.set(key, command);
};

registerSlashCommand({
  name: '/compact',
  description: 'Compact the current session and reduce context.',
  handler: async (res) => {
    try {
      log.info('Pi slash compact start', { sessionId: session.sessionId });
      await session.compact();
      log.info('Pi slash compact complete', { sessionId: session.sessionId });
      sendAssistantResult(res, 'Session compacted. Context reduced.');
    } catch (error) {
      log.error('Pi slash compact failed', serializeError(error));
      sendAssistantResult(
        res,
        error instanceof Error ? error.message : 'Compaction failed.',
      );
    }
  },
});

registerSlashCommand({
  name: '/history',
  description: 'Show session history counts and session details.',
  handler: (res) => {
    const historyMessages = getHistoryMessages(session.messages);
    const lines = [
      `Session ID: ${session.sessionId}`,
      `Current model: ${currentModelValue}`,
      `Message count: ${session.messages.length}`,
      `History entries: ${historyMessages.length}`,
      `Session file: ${session.sessionFile ?? 'none'}`,
    ];
    sendAssistantResult(res, lines.join('\n'));
  },
});

registerSlashCommand({
  name: '/model',
  description: 'Show the current model or switch to /model <provider/id>.',
  handler: async (res, args) => {
    const nextModelValue = args.trim();

    if (!nextModelValue) {
      sendAssistantResult(res, `Current model: ${currentModelValue}`);
      return;
    }

    try {
      const nextModel = resolveModel(session.modelRegistry, nextModelValue);
      await session.setModel(nextModel);
      currentModelValue = `${nextModel.provider}/${nextModel.id}`;
      log.info('Pi slash model switched', { model: currentModelValue });
      sendAssistantResult(res, `Model switched to ${currentModelValue}.`);
    } catch (error) {
      log.error('Pi slash model switch failed', serializeError(error));
      sendAssistantResult(
        res,
        error instanceof Error ? error.message : 'Model switch failed.',
      );
    }
  },
});

registerSlashCommand({
  name: '/help',
  description: 'List available slash commands.',
  handler: (res) => {
    const commandList = Array.from(slashCommands.values())
      .map((command) => `${command.name} - ${command.description}`)
      .join('\n');
    sendAssistantResult(res, commandList);
  },
});

const streamSlashCommand = async (
  res: ServerResponse,
  command: SlashCommand,
  args: string,
): Promise<void> => {
  startNdjsonResponse(res);

  try {
    await command.handler(res, args);
  } catch (error) {
    log.error('Slash command processing failed', {
      command: command.name,
      ...serializeError(error),
    });
    sendAssistantResult(res, 'Ghost server failed while processing command.');
  }
};

const handleMessage = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const bodyText = await getRequestBody(req);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const requestBody =
    typeof body === 'object' && body !== null
      ? (body as { prompt?: unknown; model?: unknown })
      : {};

  const prompt = requestBody.prompt;
  const model = typeof requestBody.model === 'string' ? requestBody.model : undefined;

  if (typeof prompt !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing prompt' }));
    return;
  }

  const slashCommand = parseSlashCommandPrompt(prompt);
  if (slashCommand) {
    const handler = slashCommands.get(slashCommand.command);
    if (handler) {
      await runQueued(() => streamSlashCommand(res, handler, slashCommand.args));
      return;
    }
  }

  await runQueued(() => streamPrompt(res, prompt, model));
};

const handleReload = async (res: ServerResponse): Promise<void> => {
  try {
    log.info('Pi reload start', { sessionId: session.sessionId });
    await runQueued(() => session.reload());
    log.info('Pi reload complete', { sessionId: session.sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'reloaded' }));
  } catch (error) {
    log.error('Pi reload failed', serializeError(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Reload failed',
      }),
    );
  }
};

const handleHistory = (res: ServerResponse): void => {
  try {
    const messages = getHistoryMessages(session.messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
  } catch (error) {
    log.error('Pi history failed', serializeError(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'History failed',
      }),
    );
  }
};

const handleCompact = async (res: ServerResponse): Promise<void> => {
  try {
    log.info('Pi compact start', { sessionId: session.sessionId });
    await runQueued(() => session.compact());
    log.info('Pi compact complete', { sessionId: session.sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'compacted' }));
  } catch (error) {
    log.error('Pi compact failed', serializeError(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Compaction failed',
      }),
    );
  }
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  log.info('Request received', { method: req.method, url: req.url ?? '' });

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    log.info('Response sent', { method: req.method, url: req.url, status: 200 });
    return;
  }

  if (configuredApiKeys.length > 0) {
    const authorization = req.headers.authorization;
    const bearerToken =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';

    if (!bearerToken || !configuredApiKeys.includes(bearerToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      log.info('Response sent', { method: req.method, url: req.url, status: 401 });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/message') {
    await handleMessage(req, res);
    log.info('Response sent', { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === 'GET' && req.url === '/history') {
    handleHistory(res);
    log.info('Response sent', { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === 'GET' && req.url === '/commands') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        Array.from(slashCommands.values()).map(({ name, description }) => ({
          name,
          description,
        })),
      ),
    );
    log.info('Response sent', { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === 'POST' && req.url === '/reload') {
    await handleReload(res);
    log.info('Response sent', { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  if (req.method === 'POST' && req.url === '/compact') {
    await handleCompact(res);
    log.info('Response sent', { method: req.method, url: req.url, status: res.statusCode });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  log.info('Response sent', { method: req.method, url: req.url, status: 404 });
};

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log.error('Request handling failed', serializeError(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
    log.info('Response sent', { method: req.method, url: req.url ?? '', status: 500 });
  });
});

server.listen(3000, () => {
  log.info('Ghost server listening on port 3000');
});
