// docker/ghost-server-claude.ts
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import http from "node:http";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
var CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || "/vault/.claude";
var CLAUDE_PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, "projects", "-vault");
var CLAUDE_MCP_CONFIG_PATH = join(CLAUDE_CONFIG_DIR, ".mcp.json");
var CLAUDE_APPEND_PROMPT_PATH = join(CLAUDE_CONFIG_DIR, "ghostbox-system-prompt.md");
var GHOSTBOX_SKILL_PATH = "/opt/ghostbox/skills/ghostbox-api/SKILL.md";
var GHOSTBOX_API_PORT = process.env.GHOSTBOX_API_PORT || "8008";
var GHOSTBOX_HOST_BASE = `http://host.docker.internal:${GHOSTBOX_API_PORT}`;
var GHOSTBOX_GHOST_NAME = process.env.GHOSTBOX_GHOST_NAME || "";
var MEMORY_PATH = "/vault/MEMORY.md";
var USER_PATH = "/vault/USER.md";
var HEARTBEAT_INTERVAL_MS = 30000;
var SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MEMORY_BLOCK_PLACEHOLDER = "<!-- GHOSTBOX_MEMORY_BLOCKS -->";
var defaultSystemPrompt = 'You are a ghost agent. Your vault at /vault is your persistent memory. Use memory_write to save facts (target "memory" for notes, target "user" for user profile). Use memory_show to check your current memory. Use `qmd` to search and read vault files on demand. Before responding to complex questions, check your memory and vault first. Write findings to /vault/knowledge/. Create tools in /vault/.pi/extensions/. Everything in /vault persists across sessions. The rest of the filesystem is throwaway.';
var memoryCharLimit = 4000;
var userCharLimit = 2000;
var parseApiKeys = (value) => {
  if (!value || value.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("GHOSTBOX_API_KEYS must be a JSON array of strings");
  }
  return parsed;
};
var configuredApiKeys = parseApiKeys(process.env.GHOSTBOX_API_KEYS);
var log = (level, message, context) => {
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  const line = `[${new Date().toISOString()}] [ghost-server-claude] ${level} ${message}${suffix}
`;
  process.stderr.write(line);
};
var isRecord = (value) => {
  return typeof value === "object" && value !== null;
};
var getString = (value) => {
  return typeof value === "string" ? value : null;
};
var getNumber = (value) => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
var extractText = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      if (typeof item.content === "string") {
        return item.content;
      }
      return "";
    }).join("");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
  }
  return "";
};
var stringifyUnknown = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
var stripAnthropicPrefix = (value) => {
  return value.startsWith("anthropic/") ? value.slice("anthropic/".length) : value;
};
var getInitialModel = () => {
  const configured = process.env.GHOSTBOX_MODEL?.trim();
  if (!configured) {
    return "claude-sonnet-4-6";
  }
  return stripAnthropicPrefix(configured);
};
var sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var sendJsonError = (res, status, message, extra) => {
  sendJson(res, status, { error: message, ...extra ?? {} });
};
var startNdjsonResponse = (res) => {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
};
var sendJsonLine = (res, payload) => {
  res.write(`${JSON.stringify(payload)}
`);
};
var sendAssistantResult = (res, text, sessionId) => {
  sendJsonLine(res, { type: "assistant", text });
  sendJsonLine(res, { type: "result", text, sessionId });
  res.end();
};
var getRequestBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var parseJsonBody = async (req) => {
  const body = await getRequestBody(req);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
};
var parseJsonBodyOrRespond = async (req, res) => {
  try {
    return await parseJsonBody(req);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJsonError(res, 400, "Invalid JSON body");
      return;
    }
    throw error;
  }
};
var ensureNoImages = (imagesValue) => {
  if (imagesValue === undefined) {
    return {};
  }
  if (!Array.isArray(imagesValue)) {
    return { error: "Invalid images" };
  }
  if (imagesValue.length > 0) {
    return { error: "Images are not supported by the claude-code adapter." };
  }
  return {};
};
var validateSessionId = (sessionId) => {
  return SESSION_ID_PATTERN.test(sessionId);
};
var sanitizeSessionName = (name) => {
  const sanitized = name.trim();
  const fileName = basename(sanitized);
  if (!fileName || fileName !== sanitized || fileName.startsWith(".") || fileName.includes("/") || fileName.includes("\\") || fileName.toLowerCase().endsWith(".jsonl")) {
    return null;
  }
  return fileName;
};
var getSessionFilePath = (sessionId) => {
  return join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`);
};
var readJsonLines = async (path) => {
  const content = await readFile(path, "utf8");
  const lines = content.split(`
`).map((line) => line.trim()).filter((line) => line.length > 0);
  const parsedLines = [];
  for (const [index, line] of lines.entries()) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      if (index < lines.length - 1) {
        log("ERROR", "Failed to parse JSONL line", {
          path,
          error: error.message,
          line
        });
      }
    }
  }
  return parsedLines;
};
var fileExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
var sessionFileExists = async (sessionId) => {
  if (!sessionId) {
    return false;
  }
  return fileExists(getSessionFilePath(sessionId));
};
var readFileText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};
var renderMemoryBlock = (label, content, limit) => {
  if (!content) {
    return "";
  }
  const pct = Math.round(content.length / limit * 100);
  const separator = "=".repeat(50);
  return `${separator}
${label} [${pct}% - ${content.length}/${limit} chars]
${separator}
${content}`;
};
var getBaseSystemPrompt = () => {
  return process.env.GHOSTBOX_SYSTEM_PROMPT?.trim() || defaultSystemPrompt;
};
var buildMemoryBlocks = async () => {
  const memoryContent = (await readFileText(MEMORY_PATH)).trim();
  const userContent = (await readFileText(USER_PATH)).trim();
  const blocks = [];
  if (memoryContent) {
    blocks.push(renderMemoryBlock("MEMORY (your personal notes)", memoryContent, memoryCharLimit));
  }
  if (userContent) {
    blocks.push(renderMemoryBlock("USER PROFILE (who the user is)", userContent, userCharLimit));
  }
  return blocks.join(`

`);
};
var buildAppendSystemPrompt = async () => {
  const staticPrompt = await readFileText(CLAUDE_APPEND_PROMPT_PATH);
  const memoryBlocks = await buildMemoryBlocks();
  const replacement = memoryBlocks.length > 0 ? `${memoryBlocks}

` : "";
  return staticPrompt.replace(`${MEMORY_BLOCK_PLACEHOLDER}

`, replacement).replace(MEMORY_BLOCK_PLACEHOLDER, "");
};
var ensureClaudeSupportFiles = async () => {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true, mode: 448 });
  await mkdir(CLAUDE_PROJECTS_DIR, { recursive: true, mode: 448 });
  if (!await fileExists(CLAUDE_APPEND_PROMPT_PATH)) {
    const skillText = await readFileText(GHOSTBOX_SKILL_PATH);
    const promptParts = [getBaseSystemPrompt(), MEMORY_BLOCK_PLACEHOLDER, skillText.trim()].filter((part) => part.length > 0);
    await writeFile(CLAUDE_APPEND_PROMPT_PATH, `${promptParts.join(`

`)}
`, "utf8");
  }
  if (!await fileExists(CLAUDE_MCP_CONFIG_PATH)) {
    const payload = {
      mcpServers: {
        ghostbox: {
          command: "node",
          args: ["/ghostbox-mcp-server.js"]
        }
      }
    };
    await writeFile(CLAUDE_MCP_CONFIG_PATH, `${JSON.stringify(payload, null, 2)}
`, "utf8");
  }
};
var createUserTurn = (text) => {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: text
    }
  })}
`;
};
var hostRequest = async (method, path, body) => {
  const response = await fetch(`${GHOSTBOX_HOST_BASE}${path}`, {
    method,
    headers: {
      ...body === undefined ? {} : { "Content-Type": "application/json" },
      ...configuredApiKeys[0] ? { Authorization: `Bearer ${configuredApiKeys[0]}` } : {}
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) }
  });
  const text = await response.text();
  if (!response.ok) {
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.error === "string") {
          throw new Error(parsed.error);
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
      }
    }
    throw new Error(`Host request failed with status ${response.status}.`);
  }
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
};
var readSessionTimestamp = (line, fallback) => {
  if (!line) {
    return fallback.toISOString();
  }
  const candidates = [line.timestamp, line.createdAt, line.created_at, line.time];
  for (const candidate of candidates) {
    const stringValue = getString(candidate);
    if (stringValue) {
      return stringValue;
    }
    const numberValue = getNumber(candidate);
    if (numberValue !== null) {
      return new Date(numberValue).toISOString();
    }
  }
  return fallback.toISOString();
};
var parseHistoryMessage = (line) => {
  const role = getString(line.type);
  const timestamp = readSessionTimestamp(line, new Date);
  const message = isRecord(line.message) ? line.message : null;
  if (role === "user") {
    const text = extractText(message?.content ?? line.content ?? line.text);
    return { role: "user", text, timestamp };
  }
  if (role === "assistant") {
    const text = extractText(message?.content ?? line.content ?? line.text);
    return { role: "assistant", text, timestamp };
  }
  if (role === "tool_use") {
    const toolName = getString(line.toolName) ?? getString(line.name) ?? getString(message?.toolName) ?? getString(message?.name) ?? undefined;
    const text = stringifyUnknown(line.input ?? message?.input ?? message?.content ?? line.content);
    return { role: "tool_use", text, toolName, timestamp };
  }
  if (role === "tool_result") {
    const toolName = getString(line.toolName) ?? getString(line.name) ?? getString(message?.toolName) ?? getString(message?.name) ?? undefined;
    const text = stringifyUnknown(line.output ?? message?.output ?? message?.content ?? line.content);
    return { role: "tool_result", text, toolName, timestamp };
  }
  return null;
};
var parseCompactions = (lines) => {
  return lines.filter((line) => line.isReplay === true && getString(line.type) === "local-command-stdout").map((line) => ({
    timestamp: readSessionTimestamp(line, new Date),
    summary: extractText(line.message ?? line.content ?? line.text) || "Session compacted.",
    tokensBefore: 0
  })).filter((entry) => entry.summary.toLowerCase().includes("compact"));
};
var loadHistoryResponse = async (sessionId) => {
  if (!sessionId || !await sessionFileExists(sessionId)) {
    return { messages: [], preCompactionMessages: [], compactions: [] };
  }
  const lines = await readJsonLines(getSessionFilePath(sessionId));
  return {
    messages: lines.map(parseHistoryMessage).filter((message) => message !== null),
    preCompactionMessages: [],
    compactions: parseCompactions(lines)
  };
};
var loadSessions = async () => {
  if (!await fileExists(CLAUDE_PROJECTS_DIR)) {
    return { current: currentSessionId ?? "", sessions: [] };
  }
  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const sessions = [];
  for (const entry of sessionFiles) {
    const fullPath = join(CLAUDE_PROJECTS_DIR, entry);
    const stats = await stat(fullPath);
    const lines = await readJsonLines(fullPath).catch(() => []);
    const createdAt = readSessionTimestamp(lines[0], stats.birthtime);
    sessions.push({
      id: basename(entry, ".jsonl"),
      name: null,
      path: fullPath,
      createdAt,
      lastActiveAt: stats.mtime.toISOString()
    });
  }
  return {
    current: currentSessionId ?? "",
    sessions
  };
};
var loadStatsFromSessionFile = async (sessionId) => {
  if (!sessionId || !await sessionFileExists(sessionId)) {
    return {
      sessionId: sessionId ?? "",
      model: currentModel,
      tokens: 0,
      cost: 0,
      messageCount: 0,
      context: null
    };
  }
  const lines = await readJsonLines(getSessionFilePath(sessionId));
  const history = lines.map(parseHistoryMessage).filter((message) => message !== null);
  const resultLine = [...lines].reverse().find((line) => getString(line.type) === "result");
  const usageRecord = isRecord(resultLine?.usage) ? resultLine.usage : null;
  const inputTokens = getNumber(usageRecord?.input_tokens) ?? getNumber(usageRecord?.inputTokens) ?? getNumber(usageRecord?.prompt_tokens) ?? 0;
  const outputTokens = getNumber(usageRecord?.output_tokens) ?? getNumber(usageRecord?.outputTokens) ?? getNumber(usageRecord?.completion_tokens) ?? 0;
  const totalTokens = getNumber(usageRecord?.total_tokens) ?? inputTokens + outputTokens;
  const cost = getNumber(resultLine?.total_cost_usd) ?? 0;
  return {
    sessionId,
    model: currentModel,
    tokens: totalTokens,
    cost,
    messageCount: history.length,
    context: null
  };
};
var parseSlashPrompt = (prompt) => {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const spaceIndex = trimmed.indexOf(" ");
  const command = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim().toLowerCase();
  if (!command) {
    return null;
  }
  return {
    command,
    args: spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim()
  };
};
var getEventName = (line) => {
  const type = getString(line.type);
  const subtype = getString(line.subtype);
  if (type && subtype) {
    return `${type}/${subtype}`;
  }
  return type ?? "";
};
var getStreamEvent = (line) => {
  const candidates = [line.stream_event, line.event, line.payload];
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
};
var extractSessionId = (line) => {
  const candidates = [
    line.session_id,
    line.sessionId,
    isRecord(line.data) ? line.data.session_id : null,
    isRecord(line.data) ? line.data.sessionId : null
  ];
  for (const candidate of candidates) {
    const sessionId = getString(candidate);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
};
var extractAssistantFallback = (line) => {
  const message = isRecord(line.message) ? line.message : null;
  return extractText(line.text) || extractText(line.content) || extractText(message?.content) || extractText(message?.text) || "";
};
var parseToolInput = (state) => {
  if (state.currentToolInputBuffer.trim().length > 0) {
    try {
      return JSON.parse(state.currentToolInputBuffer);
    } catch {
      return state.currentToolInputBuffer;
    }
  }
  return state.currentToolInputValue ?? null;
};
var emitTextBlockIfNeeded = (res, state) => {
  if (state.currentBlockType !== "text") {
    return;
  }
  if (state.textBuffer.trim().length === 0) {
    state.textBuffer = "";
    state.emittedAssistantForBlock = false;
    return;
  }
  sendJsonLine(res, { type: "assistant", text: state.textBuffer });
  state.lastAssistantText = state.textBuffer;
  state.assistantFallback = state.textBuffer;
  state.textBuffer = "";
  state.emittedAssistantForBlock = true;
};
var emitToolUseIfNeeded = (res, state) => {
  if (state.currentBlockType !== "tool_use" || !state.currentToolName) {
    return;
  }
  sendJsonLine(res, {
    type: "tool_use",
    tool: state.currentToolName,
    input: parseToolInput(state)
  });
  state.currentToolName = null;
  state.currentToolInputBuffer = "";
  state.currentToolInputValue = null;
};
var resetCurrentBlock = (state) => {
  state.currentBlockType = null;
  state.emittedAssistantForBlock = false;
};
var createStreamState = () => ({
  textBuffer: "",
  lastAssistantText: "",
  assistantFallback: "",
  receivedResultEvent: false,
  thinkingBuffer: "",
  currentBlockType: null,
  currentToolName: null,
  currentToolInputBuffer: "",
  currentToolInputValue: null,
  emittedAssistantForBlock: false
});
var applyResultUsage = (line) => {
  const usageRecord = isRecord(line.usage) ? line.usage : null;
  const inputTokens = getNumber(usageRecord?.input_tokens) ?? getNumber(usageRecord?.inputTokens) ?? getNumber(usageRecord?.prompt_tokens) ?? 0;
  const outputTokens = getNumber(usageRecord?.output_tokens) ?? getNumber(usageRecord?.outputTokens) ?? getNumber(usageRecord?.completion_tokens) ?? 0;
  const totalTokens = getNumber(usageRecord?.total_tokens) ?? inputTokens + outputTokens;
  const cost = getNumber(line.total_cost_usd) ?? 0;
  latestStats = {
    sessionId: currentSessionId ?? "",
    model: currentModel,
    tokens: totalTokens,
    cost,
    messageCount: latestStats?.messageCount ?? 0,
    context: null,
    updatedAt: new Date().toISOString()
  };
};
var handleClaudeStreamLine = (res, line, state) => {
  const eventName = getEventName(line);
  const sessionId = extractSessionId(line);
  if (sessionId) {
    currentSessionId = sessionId;
  }
  if (eventName === "system/init") {
    return;
  }
  if (eventName === "assistant") {
    const fallback = extractAssistantFallback(line);
    if (fallback) {
      state.assistantFallback = fallback;
    }
    return;
  }
  if (eventName === "result") {
    state.receivedResultEvent = true;
    if (!state.lastAssistantText && state.assistantFallback) {
      sendJsonLine(res, { type: "assistant", text: state.assistantFallback });
      state.lastAssistantText = state.assistantFallback;
    }
    applyResultUsage(line);
    sendJsonLine(res, {
      type: "result",
      text: state.lastAssistantText || state.assistantFallback,
      sessionId: currentSessionId ?? ""
    });
    return;
  }
  if (eventName !== "stream_event") {
    return;
  }
  const streamEvent = getStreamEvent(line);
  if (!streamEvent) {
    return;
  }
  const streamType = getString(streamEvent.type);
  const delta = isRecord(streamEvent.delta) ? streamEvent.delta : null;
  const contentBlock = isRecord(streamEvent.content_block) ? streamEvent.content_block : null;
  if (streamType === "content_block_start") {
    const blockType = getString(contentBlock?.type);
    if (blockType === "text") {
      state.currentBlockType = "text";
      state.textBuffer = "";
      state.emittedAssistantForBlock = false;
      return;
    }
    if (blockType === "thinking") {
      state.currentBlockType = "thinking";
      state.thinkingBuffer = "";
      return;
    }
    if (blockType === "tool_use") {
      state.currentBlockType = "tool_use";
      state.currentToolName = getString(contentBlock?.name);
      state.currentToolInputBuffer = "";
      state.currentToolInputValue = contentBlock?.input ?? null;
      return;
    }
  }
  if (streamType === "content_block_delta") {
    const deltaType = getString(delta?.type);
    if (deltaType === "text_delta" && typeof delta?.text === "string") {
      state.textBuffer += delta.text;
      return;
    }
    if (deltaType === "thinking_delta" && typeof delta?.thinking === "string") {
      state.thinkingBuffer += delta.thinking;
      sendJsonLine(res, { type: "thinking", text: state.thinkingBuffer });
      return;
    }
    if (deltaType === "thinking_delta" && typeof delta?.text === "string") {
      state.thinkingBuffer += delta.text;
      sendJsonLine(res, { type: "thinking", text: state.thinkingBuffer });
      return;
    }
    if (deltaType === "input_json_delta" && typeof delta?.partial_json === "string") {
      state.currentToolInputBuffer += delta.partial_json;
      return;
    }
  }
  if (streamType === "content_block_stop") {
    if (state.currentBlockType === "text") {
      emitTextBlockIfNeeded(res, state);
      resetCurrentBlock(state);
      return;
    }
    if (state.currentBlockType === "tool_use") {
      emitToolUseIfNeeded(res, state);
      resetCurrentBlock(state);
      return;
    }
    if (state.currentBlockType === "thinking") {
      resetCurrentBlock(state);
      state.thinkingBuffer = "";
    }
  }
};
var buildClaudeArgs = async (messages) => {
  await ensureClaudeSupportFiles();
  const args = [
    ...currentSessionId && await sessionFileExists(currentSessionId) ? ["--resume", currentSessionId] : [],
    "--model",
    currentModel,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    await buildAppendSystemPrompt(),
    "--mcp-config",
    CLAUDE_MCP_CONFIG_PATH,
    "--dangerously-skip-permissions"
  ];
  if (messages.length === 0) {
    throw new Error("No user messages to send.");
  }
  return args;
};
var startHeartbeat = (res) => {
  return setInterval(() => {
    sendJsonLine(res, { type: "heartbeat" });
  }, HEARTBEAT_INTERVAL_MS);
};
var clearActiveTurn = () => {
  if (activeTurn?.heartbeat) {
    clearInterval(activeTurn.heartbeat);
  }
  activeTurn = null;
};
var spawnClaudeMessage = async (res, messages) => {
  const args = await buildClaudeArgs(messages);
  const child = nodeSpawn("claude", args, {
    cwd: "/vault",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const state = createStreamState();
  const stdoutDecoder = new StringDecoder("utf8");
  activeTurn = {
    child,
    heartbeat: startHeartbeat(res),
    buffer: "",
    finished: false,
    pendingResultSessionId: null
  };
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  child.stdout.on("data", (chunk) => {
    if (!activeTurn) {
      return;
    }
    activeTurn.buffer += stdoutDecoder.write(chunk);
    const lines = activeTurn.buffer.split(`
`);
    activeTurn.buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        handleClaudeStreamLine(res, parsed, state);
        if (getEventName(parsed) === "result") {
          activeTurn.finished = true;
          if (!res.writableEnded) {
            res.end();
          }
        }
      } catch (error) {
        log("ERROR", "Failed to parse Claude stream line", {
          error: error instanceof Error ? error.message : String(error),
          line: trimmed
        });
      }
    }
  });
  child.on("error", (error) => {
    log("ERROR", "Claude process error", { error: error.message });
    if (!res.writableEnded) {
      sendJsonLine(res, {
        type: "result",
        text: "Ghost server failed while processing message.",
        sessionId: currentSessionId ?? ""
      });
      res.end();
    }
    clearActiveTurn();
  });
  child.on("close", (code) => {
    if (activeTurn) {
      activeTurn.buffer += stdoutDecoder.end();
    }
    const trailingLine = activeTurn?.buffer.trim();
    if (trailingLine) {
      try {
        const parsed = JSON.parse(trailingLine);
        handleClaudeStreamLine(res, parsed, state);
      } catch (error) {
        log("ERROR", "Failed to parse trailing Claude stream line", {
          error: error instanceof Error ? error.message : String(error),
          line: trailingLine
        });
      }
    }
    if (activeTurn?.heartbeat) {
      clearInterval(activeTurn.heartbeat);
    }
    if (!res.writableEnded) {
      if ((code ?? 0) !== 0 && !state.receivedResultEvent) {
        const message = `Claude subprocess exited with code ${code ?? 1}.`;
        log("ERROR", message, { sessionId: currentSessionId ?? "" });
        sendJsonLine(res, {
          type: "result",
          text: message,
          sessionId: currentSessionId ?? ""
        });
        res.end();
        clearActiveTurn();
        return;
      }
      if (!state.lastAssistantText && state.assistantFallback) {
        sendJsonLine(res, { type: "assistant", text: state.assistantFallback });
      }
      sendJsonLine(res, {
        type: "result",
        text: state.lastAssistantText || state.assistantFallback,
        sessionId: currentSessionId ?? ""
      });
      res.end();
    }
    clearActiveTurn();
  });
  for (const message of messages) {
    child.stdin.write(createUserTurn(message));
  }
  child.stdin.end();
};
var runCompactCommand = async () => {
  if (!currentSessionId || !await sessionFileExists(currentSessionId)) {
    throw new Error("No active session to compact.");
  }
  await ensureClaudeSupportFiles();
  return new Promise((resolve, reject) => {
    const args = [
      "--resume",
      currentSessionId,
      "-p",
      "/compact",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "15",
      "--dangerously-skip-permissions",
      "--mcp-config",
      CLAUDE_MCP_CONFIG_PATH
    ];
    const child = nodeSpawn("claude", args, {
      cwd: "/vault",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let buffer = "";
    let fallback = "";
    let lastText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk) => {
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split(`
`);
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const line = JSON.parse(trimmed);
          const eventName = getEventName(line);
          const sessionId = extractSessionId(line);
          if (sessionId) {
            currentSessionId = sessionId;
          }
          if (eventName === "assistant") {
            fallback = extractAssistantFallback(line) || fallback;
          }
          if (eventName === "result") {
            applyResultUsage(line);
            lastText = getString(line.text) ?? fallback;
          }
        } catch (error) {
          log("ERROR", "Failed to parse Claude compact line", {
            error: error instanceof Error ? error.message : String(error),
            line: trimmed
          });
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      buffer += stdoutDecoder.end();
      const trailingLine = buffer.trim();
      if (trailingLine) {
        try {
          const line = JSON.parse(trailingLine);
          const eventName = getEventName(line);
          const sessionId = extractSessionId(line);
          if (sessionId) {
            currentSessionId = sessionId;
          }
          if (eventName === "assistant") {
            fallback = extractAssistantFallback(line) || fallback;
          }
          if (eventName === "result") {
            applyResultUsage(line);
            lastText = getString(line.text) ?? fallback;
          }
        } catch (error) {
          log("ERROR", "Failed to parse trailing Claude compact line", {
            error: error instanceof Error ? error.message : String(error),
            line: trailingLine
          });
        }
      }
      if (code !== 0) {
        reject(new Error(`claude compact failed with exit code ${code ?? 1}.`));
        return;
      }
      resolve(lastText || fallback || "Session compacted.");
    });
  });
};
var listSupportedCommands = () => [
  { name: "/compact", description: "Compact the current session and reduce context." },
  { name: "/new", description: "Start a fresh Claude Code session." },
  { name: "/reload", description: "No-op for Claude Code compatibility." },
  { name: "/help", description: "List available slash commands." }
];
var handleSlashCommand = async (res, prompt) => {
  const slash = parseSlashPrompt(prompt);
  if (!slash) {
    return false;
  }
  startNdjsonResponse(res);
  if (slash.command === "help") {
    sendAssistantResult(res, listSupportedCommands().map((command) => `${command.name} - ${command.description}`).join(`
`), currentSessionId ?? "");
    return true;
  }
  if (slash.command === "reload") {
    sendAssistantResult(res, "Claude Code reload is not needed.", currentSessionId ?? "");
    return true;
  }
  if (slash.command === "new") {
    currentSessionId = null;
    queue.messages = [];
    sendAssistantResult(res, "New session started.", "");
    return true;
  }
  if (slash.command === "compact") {
    try {
      const summary = await runCompactCommand();
      sendAssistantResult(res, summary, currentSessionId ?? "");
    } catch (error) {
      sendAssistantResult(res, error instanceof Error ? error.message : "Compaction failed.", currentSessionId ?? "");
    }
    return true;
  }
  sendAssistantResult(res, `Unknown command: /${slash.command}`, currentSessionId ?? "");
  return true;
};
var currentSessionId = null;
var currentModel = getInitialModel();
var activeTurn = null;
var sessionOpLock = false;
var queue = { messages: [] };
var latestStats = null;
await ensureClaudeSupportFiles();
var recoverMostRecentSession = async () => {
  if (!await fileExists(CLAUDE_PROJECTS_DIR)) {
    return;
  }
  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl"));
  if (sessionFiles.length === 0) {
    return;
  }
  let newest = null;
  for (const entry of sessionFiles) {
    const stats = await stat(join(CLAUDE_PROJECTS_DIR, entry));
    const mtime = stats.mtime.getTime();
    if (!newest || mtime > newest.mtime) {
      newest = { id: basename(entry, ".jsonl"), mtime };
    }
  }
  if (newest) {
    currentSessionId = newest.id;
  }
};
await recoverMostRecentSession();
var handleMessage = async (req, res) => {
  const body = await parseJsonBodyOrRespond(req, res);
  if (body === undefined) {
    return;
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    sendJsonError(res, 400, "Missing prompt");
    return;
  }
  const imageValidation = ensureNoImages(body.images);
  if (imageValidation.error) {
    sendJsonError(res, 400, imageValidation.error);
    return;
  }
  if (typeof body.model === "string" && body.model.trim()) {
    currentModel = stripAnthropicPrefix(body.model.trim());
  }
  if (await handleSlashCommand(res, prompt)) {
    return;
  }
  if (sessionOpLock) {
    sendJsonError(res, 409, "Turn in progress, try again.");
    return;
  }
  if (activeTurn) {
    queue.messages.push(prompt);
    startNdjsonResponse(res);
    sendJsonLine(res, {
      type: "result",
      text: "Queued for next turn.",
      sessionId: currentSessionId ?? ""
    });
    res.end();
    return;
  }
  const queuedMessages = [...queue.messages];
  queue.messages = [];
  sessionOpLock = true;
  try {
    startNdjsonResponse(res);
    await spawnClaudeMessage(res, [...queuedMessages, prompt]);
  } finally {
    sessionOpLock = false;
  }
};
var handleSteer = async (req, res) => {
  const body = await parseJsonBodyOrRespond(req, res);
  if (body === undefined) {
    return;
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    sendJsonError(res, 400, "Missing prompt");
    return;
  }
  const imageValidation = ensureNoImages(body.images);
  if (imageValidation.error) {
    sendJsonError(res, 400, imageValidation.error);
    return;
  }
  if (!activeTurn) {
    sendJsonError(res, 400, "no active turn to steer");
    return;
  }
  activeTurn.child.stdin.write(createUserTurn(prompt));
  sendJson(res, 200, { status: "queued", pendingCount: queue.messages.length });
};
var handleQueue = (res) => {
  const response = {
    steering: [],
    followUp: [...queue.messages],
    pendingCount: queue.messages.length
  };
  sendJson(res, 200, response);
};
var handleClearQueue = (res) => {
  const response = {
    cleared: {
      steering: [],
      followUp: [...queue.messages]
    }
  };
  queue.messages = [];
  sendJson(res, 200, response);
};
var handleHistory = async (res) => {
  sendJson(res, 200, await loadHistoryResponse(currentSessionId));
};
var handleSessions = async (res) => {
  sendJson(res, 200, await loadSessions());
};
var handleStats = async (res) => {
  const baseStats = latestStats ? { ...latestStats } : await loadStatsFromSessionFile(currentSessionId);
  if (currentSessionId && await sessionFileExists(currentSessionId)) {
    const history = await loadHistoryResponse(currentSessionId);
    baseStats.messageCount = history.messages.length;
  }
  sendJson(res, 200, {
    sessionId: baseStats.sessionId,
    model: baseStats.model,
    tokens: baseStats.tokens,
    cost: baseStats.cost,
    messageCount: baseStats.messageCount,
    context: baseStats.context
  });
};
var handleCompact = async (res) => {
  if (activeTurn) {
    sendJsonError(res, 409, "Active turn in progress.");
    return;
  }
  const summary = await runCompactCommand();
  sendJson(res, 200, { status: "compacted", summary });
};
var handleNew = (res) => {
  currentSessionId = null;
  queue.messages = [];
  latestStats = null;
  sendJson(res, 200, { status: "new_session", sessionId: "" });
};
var handleAbort = (res) => {
  if (activeTurn) {
    activeTurn.child.kill("SIGTERM");
  }
  sendJson(res, 200, { status: "aborted" });
};
var handleTaskKill = (res) => {
  sendJson(res, 501, { error: "Background task killing is not supported by the claude-code adapter." });
};
var handleReload = (res) => {
  sendJson(res, 200, { status: "reloaded", warning: "No-op for claude-code adapter." });
};
var handleSwitchSession = async (req, res) => {
  const body = await parseJsonBodyOrRespond(req, res);
  if (body === undefined) {
    return;
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }
  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
    return;
  }
  if (!await sessionFileExists(sessionId)) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }
  currentSessionId = sessionId;
  sendJson(res, 200, { status: "switched", sessionId });
};
var handleRenameSession = async (req, res) => {
  const body = await parseJsonBodyOrRespond(req, res);
  if (body === undefined) {
    return;
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }
  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
    return;
  }
  if (!name) {
    sendJsonError(res, 400, "Missing name");
    return;
  }
  const sourcePath = getSessionFilePath(sessionId);
  if (!await fileExists(sourcePath)) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }
  const sanitizedName = sanitizeSessionName(name);
  if (!sanitizedName) {
    sendJsonError(res, 400, "Invalid session name");
    return;
  }
  if (activeTurn || sessionOpLock) {
    sendJsonError(res, 409, "Turn in progress, try again.");
    return;
  }
  const targetPath = getSessionFilePath(sanitizedName);
  sessionOpLock = true;
  try {
    if (await fileExists(targetPath)) {
      sendJsonError(res, 409, "A session with that name already exists.");
      return;
    }
    await rename(sourcePath, targetPath);
    if (currentSessionId === sessionId) {
      currentSessionId = sanitizedName;
    }
  } finally {
    sessionOpLock = false;
  }
  sendJson(res, 200, { status: "renamed", sessionId: sanitizedName, name: sanitizedName });
};
var handleDeleteSession = async (req, res) => {
  const sessionId = req.url?.replace("/sessions/", "").trim() ?? "";
  if (!sessionId) {
    sendJsonError(res, 400, "Missing sessionId");
    return;
  }
  if (!validateSessionId(sessionId)) {
    sendJsonError(res, 400, "Invalid session id");
    return;
  }
  if (currentSessionId === sessionId) {
    sendJsonError(res, 409, "Cannot delete the active session");
    return;
  }
  const targetPath = getSessionFilePath(sessionId);
  if (!await fileExists(targetPath)) {
    sendJsonError(res, 404, `Session "${sessionId}" not found`);
    return;
  }
  await unlink(targetPath);
  sendJson(res, 200, { status: "deleted", sessionId });
};
var handleSchedules = async (req, res) => {
  if (!GHOSTBOX_GHOST_NAME) {
    sendJsonError(res, 500, "GHOSTBOX_GHOST_NAME is not configured.");
    return;
  }
  const basePath = `/api/ghosts/${encodeURIComponent(GHOSTBOX_GHOST_NAME)}/schedules`;
  if (req.method === "GET") {
    sendJson(res, 200, await hostRequest("GET", basePath));
    return;
  }
  if (req.method === "POST") {
    const body = await parseJsonBodyOrRespond(req, res);
    if (body === undefined) {
      return;
    }
    sendJson(res, 201, await hostRequest("POST", basePath, {
      ...typeof body.cron === "string" ? { cron: body.cron } : {},
      ...typeof body.prompt === "string" ? { prompt: body.prompt } : {},
      ...typeof body.once === "boolean" ? { once: body.once } : {},
      ...typeof body.timezone === "string" ? { timezone: body.timezone } : {}
    }));
    return;
  }
  if (req.method === "DELETE") {
    const scheduleId = req.url?.replace("/schedules/", "").trim() ?? "";
    if (!scheduleId) {
      sendJsonError(res, 400, "Missing schedule id");
      return;
    }
    sendJson(res, 200, await hostRequest("DELETE", `${basePath}/${encodeURIComponent(scheduleId)}`));
    return;
  }
  sendJsonError(res, 405, "Method not allowed");
};
var handleNudgeStatus = (res) => {
  sendJson(res, 200, { supported: false, status: "unsupported" });
};
var handleNudge = (res) => {
  sendJson(res, 200, { ok: true, warning: "Nudges are not supported by the claude-code adapter." });
};
var handleCommands = (res) => {
  sendJson(res, 200, listSupportedCommands());
};
var authenticateRequest = (req, res) => {
  if (configuredApiKeys.length === 0) {
    return true;
  }
  const authorization = req.headers.authorization;
  const bearerToken = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!bearerToken || !configuredApiKeys.includes(bearerToken)) {
    sendJsonError(res, 401, "Unauthorized");
    return false;
  }
  return true;
};
var handleRequest = async (req, res) => {
  log("INFO", "Request received", { method: req.method ?? "", url: req.url ?? "" });
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (!authenticateRequest(req, res)) {
    return;
  }
  if (req.method === "POST" && req.url === "/message") {
    await handleMessage(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/steer") {
    await handleSteer(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/queue") {
    handleQueue(res);
    return;
  }
  if (req.method === "POST" && req.url === "/clear-queue") {
    handleClearQueue(res);
    return;
  }
  if (req.method === "GET" && req.url === "/history") {
    await handleHistory(res);
    return;
  }
  if (req.method === "GET" && req.url === "/sessions") {
    await handleSessions(res);
    return;
  }
  if (req.method === "GET" && req.url === "/stats") {
    await handleStats(res);
    return;
  }
  if (req.method === "GET" && req.url === "/schedules" || req.method === "POST" && req.url === "/schedules" || req.method === "DELETE" && req.url?.startsWith("/schedules/")) {
    await handleSchedules(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/compact") {
    await handleCompact(res);
    return;
  }
  if (req.method === "POST" && req.url === "/new") {
    handleNew(res);
    return;
  }
  if (req.method === "POST" && req.url === "/abort") {
    handleAbort(res);
    return;
  }
  if (req.method === "POST" && req.url === "/reload") {
    handleReload(res);
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/switch") {
    await handleSwitchSession(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/rename") {
    await handleRenameSession(req, res);
    return;
  }
  if (req.method === "DELETE" && req.url?.startsWith("/sessions/")) {
    await handleDeleteSession(req, res);
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/tasks/")) {
    handleTaskKill(res);
    return;
  }
  if (req.method === "GET" && req.url === "/nudge/status") {
    handleNudgeStatus(res);
    return;
  }
  if (req.method === "POST" && req.url === "/nudge") {
    handleNudge(res);
    return;
  }
  if (req.method === "GET" && req.url === "/commands") {
    handleCommands(res);
    return;
  }
  sendJsonError(res, 404, "Not found");
};
var server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log("ERROR", "Request handling failed", {
      error: error instanceof Error ? error.message : String(error),
      method: req.method ?? "",
      url: req.url ?? ""
    });
    if (!res.writableEnded) {
      sendJsonError(res, 500, error instanceof Error ? error.message : "Internal server error");
    }
  });
});
server.listen(3000, () => {
  log("INFO", "Claude ghost server listening on port 3000", {
    model: currentModel,
    hasSession: existsSync(currentSessionId ? getSessionFilePath(currentSessionId) : "")
  });
});
