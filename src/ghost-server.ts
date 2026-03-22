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
import type { GhostMessage } from './types';

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
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

  if (modelValue) {
    const nextModel = resolveModel(session.modelRegistry, modelValue);
    await session.setModel(nextModel);
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

  if (req.method === 'POST' && req.url === '/reload') {
    await handleReload(res);
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
