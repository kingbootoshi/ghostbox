// docker/ghostbox-mcp-server.ts
import { readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
var HOST_API_PORT = process.env.GHOSTBOX_API_PORT || "8008";
var HOST_API_BASE = `http://host.docker.internal:${HOST_API_PORT}`;
var GHOST_NAME = process.env.GHOSTBOX_GHOST_NAME || "";
var GHOST_API_KEY = process.env.GHOST_API_KEY || "";
var MEMORY_PATH = "/vault/MEMORY.md";
var USER_PATH = "/vault/USER.md";
var MEMORY_SEPARATOR = `
§
`;
var MEMORY_LIMITS = {
  memory: 4000,
  user: 2000
};
var server = new McpServer({
  name: "ghostbox",
  version: "1.0.0"
});
var sendLog = (message) => {
  process.stderr.write(`[ghostbox-mcp] ${message}
`);
};
var getHostHeaders = (body) => ({
  ...body === undefined ? {} : { "Content-Type": "application/json" },
  ...GHOST_API_KEY ? { Authorization: `Bearer ${GHOST_API_KEY}` } : {}
});
var readJsonResponse = async (response, context) => {
  const text = await response.text();
  if (!response.ok) {
    let message = `${context} failed with status ${response.status}.`;
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
          message = parsed.error;
        } else {
          message = `${message} ${text}`;
        }
      } catch {
        message = `${message} ${text}`;
      }
    }
    throw new Error(message.trim());
  }
  if (text.trim().length === 0) {
    return null;
  }
  return JSON.parse(text);
};
var hostRequest = async (method, path, body, context) => {
  const response = await fetch(`${HOST_API_BASE}${path}`, {
    method,
    headers: getHostHeaders(body),
    ...body === undefined ? {} : { body: JSON.stringify(body) }
  });
  return readJsonResponse(response, context ?? `${method} ${path}`);
};
var formatJson = (value) => {
  return JSON.stringify(value, null, 2);
};
var getMemoryPath = (target) => {
  return target === "memory" ? MEMORY_PATH : USER_PATH;
};
var readMemoryFile = async (target) => {
  try {
    return (await readFile(getMemoryPath(target), "utf8")).trim();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
};
var splitMemoryEntries = (content) => {
  if (!content.trim()) {
    return [];
  }
  return content.split(/\n§\n/g).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
};
var joinMemoryEntries = (entries) => {
  return entries.join(MEMORY_SEPARATOR);
};
var assertWithinMemoryLimit = (target, nextContent) => {
  const limit = MEMORY_LIMITS[target];
  if (nextContent.length > limit) {
    throw new Error(`${target.toUpperCase()} is full: ${nextContent.length}/${limit} characters.`);
  }
};
var writeMemoryFile = async (target, content) => {
  assertWithinMemoryLimit(target, content);
  await writeFile(getMemoryPath(target), content.length > 0 ? `${content}
` : "");
};
var formatMemoryShow = async (target) => {
  const targets = target ? [target] : ["memory", "user"];
  const sections = await Promise.all(targets.map(async (currentTarget) => {
    const content = await readMemoryFile(currentTarget);
    const limit = MEMORY_LIMITS[currentTarget];
    const label = currentTarget === "memory" ? "MEMORY.md" : "USER.md";
    return [
      `${label} - ${content.length}/${limit} chars`,
      content || "(empty)"
    ].join(`
`);
  }));
  return sections.join(`

`);
};
var appendMemoryEntry = async (target, content) => {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("content is required.");
  }
  const entries = splitMemoryEntries(await readMemoryFile(target));
  entries.push(trimmed);
  const nextContent = joinMemoryEntries(entries);
  await writeMemoryFile(target, nextContent);
  return `${target.toUpperCase()} updated.

${await formatMemoryShow(target)}`;
};
var replaceMemoryEntry = async (target, search, content) => {
  const trimmedSearch = search.trim();
  const trimmedContent = content.trim();
  if (!trimmedSearch) {
    throw new Error("search is required.");
  }
  if (!trimmedContent) {
    throw new Error("content is required.");
  }
  const entries = splitMemoryEntries(await readMemoryFile(target));
  const index = entries.findIndex((entry) => entry.includes(trimmedSearch));
  if (index === -1) {
    throw new Error(`No ${target} entry matched "${trimmedSearch}".`);
  }
  entries[index] = trimmedContent;
  const nextContent = joinMemoryEntries(entries);
  await writeMemoryFile(target, nextContent);
  return `${target.toUpperCase()} updated.

${await formatMemoryShow(target)}`;
};
var removeMemoryEntry = async (target, search) => {
  const trimmedSearch = search.trim();
  if (!trimmedSearch) {
    throw new Error("search is required.");
  }
  const entries = splitMemoryEntries(await readMemoryFile(target));
  const nextEntries = entries.filter((entry) => !entry.includes(trimmedSearch));
  if (nextEntries.length === entries.length) {
    throw new Error(`No ${target} entry matched "${trimmedSearch}".`);
  }
  const nextContent = joinMemoryEntries(nextEntries);
  await writeMemoryFile(target, nextContent);
  return `${target.toUpperCase()} updated.

${await formatMemoryShow(target)}`;
};
server.registerTool("mailbox", {
  description: "Send and receive messages to and from other ghosts and the user.",
  inputSchema: {
    action: z.enum(["check", "inbox", "read", "send", "reply"]).describe("Mailbox action to perform."),
    to: z.string().optional().describe("Recipient ghost name or 'user'. Required for send."),
    subject: z.string().optional().describe("Message subject. Required for send."),
    body: z.string().optional().describe("Message body. Required for send and reply."),
    messageId: z.string().optional().describe("Message id for read or reply."),
    priority: z.enum(["normal", "urgent"]).optional().describe("Optional message priority.")
  }
}, async ({ action, to, subject, body, messageId, priority }) => {
  const mailboxAction = action;
  if (!GHOST_NAME) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }
  switch (mailboxAction) {
    case "check": {
      const payload = await hostRequest("GET", `/api/mail/${encodeURIComponent(GHOST_NAME)}?unread=true`, undefined, "Mailbox unread check");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
    case "inbox": {
      const payload = await hostRequest("GET", `/api/mail/${encodeURIComponent(GHOST_NAME)}`, undefined, "Mailbox inbox");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
    case "read": {
      if (!messageId?.trim()) {
        throw new Error("messageId is required when action is read.");
      }
      const markRead = await hostRequest("POST", `/api/mail/${encodeURIComponent(messageId)}/read`, undefined, "Mailbox read");
      return { content: [{ type: "text", text: formatJson(markRead) }] };
    }
    case "send": {
      if (!to?.trim()) {
        throw new Error("to is required when action is send.");
      }
      if (!subject?.trim()) {
        throw new Error("subject is required when action is send.");
      }
      if (!body?.trim()) {
        throw new Error("body is required when action is send.");
      }
      const payload = await hostRequest("POST", "/api/mail/send", {
        from: GHOST_NAME,
        to,
        subject,
        body,
        priority: priority ?? "normal"
      }, "Mailbox send");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
    case "reply": {
      if (!messageId?.trim()) {
        throw new Error("messageId is required when action is reply.");
      }
      if (!body?.trim()) {
        throw new Error("body is required when action is reply.");
      }
      const inbox = await hostRequest("GET", `/api/mail/${encodeURIComponent(GHOST_NAME)}`, undefined, "Mailbox inbox");
      if (!Array.isArray(inbox)) {
        throw new Error("Mailbox inbox was not an array.");
      }
      const original = inbox.find((entry) => {
        return typeof entry === "object" && entry !== null && "id" in entry && entry.id === messageId;
      });
      if (!original || typeof original.from !== "string" || typeof original.subject !== "string") {
        throw new Error(`Mailbox message "${messageId}" not found.`);
      }
      const payload = await hostRequest("POST", "/api/mail/send", {
        from: GHOST_NAME,
        to: original.from,
        subject: original.subject,
        body,
        priority: priority ?? "normal",
        ...typeof original.threadId === "string" ? { threadId: original.threadId } : typeof original.id === "string" ? { threadId: original.id } : {}
      }, "Mailbox reply");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
  }
});
server.registerTool("schedule", {
  description: "Create, list, or delete recurring prompts for this ghost.",
  inputSchema: {
    action: z.enum(["create", "list", "delete"]).describe("Schedule action to perform."),
    cron: z.string().optional().describe("Five-field cron expression. Required for create."),
    prompt: z.string().optional().describe("Prompt to send when the schedule fires."),
    id: z.string().optional().describe("Schedule id for delete."),
    once: z.boolean().optional().describe("Disable the schedule after its first run."),
    timezone: z.string().optional().describe("IANA timezone like America/Los_Angeles.")
  }
}, async ({ action, cron, prompt, id, once, timezone }) => {
  const scheduleAction = action;
  if (!GHOST_NAME) {
    throw new Error("GHOSTBOX_GHOST_NAME is not configured.");
  }
  const scheduleBasePath = `/api/ghosts/${encodeURIComponent(GHOST_NAME)}/schedules`;
  switch (scheduleAction) {
    case "list": {
      const payload = await hostRequest("GET", scheduleBasePath, undefined, "Schedule list");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
    case "create": {
      if (!cron?.trim()) {
        throw new Error("cron is required when action is create.");
      }
      if (!prompt?.trim()) {
        throw new Error("prompt is required when action is create.");
      }
      const payload = await hostRequest("POST", scheduleBasePath, {
        cron,
        prompt,
        ...typeof once === "boolean" ? { once } : {},
        ...timezone?.trim() ? { timezone } : {}
      }, "Schedule create");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
    case "delete": {
      if (!id?.trim()) {
        throw new Error("id is required when action is delete.");
      }
      const payload = await hostRequest("DELETE", `${scheduleBasePath}/${encodeURIComponent(id)}`, undefined, "Schedule delete");
      return { content: [{ type: "text", text: formatJson(payload) }] };
    }
  }
});
server.registerTool("memory_write", {
  description: "Append a new entry to MEMORY.md or USER.md.",
  inputSchema: {
    target: z.enum(["memory", "user"]).describe("Which warm-memory file to update."),
    content: z.string().describe("Entry text to append.")
  }
}, async ({ target, content }) => ({
  content: [{ type: "text", text: await appendMemoryEntry(target, content) }]
}));
server.registerTool("memory_replace", {
  description: "Replace the first warm-memory entry that matches a substring.",
  inputSchema: {
    target: z.enum(["memory", "user"]).describe("Which warm-memory file to update."),
    search: z.string().describe("Substring to find in the current entries."),
    content: z.string().describe("Replacement entry text.")
  }
}, async ({ target, search, content }) => ({
  content: [{ type: "text", text: await replaceMemoryEntry(target, search, content) }]
}));
server.registerTool("memory_remove", {
  description: "Remove warm-memory entries that match a substring.",
  inputSchema: {
    target: z.enum(["memory", "user"]).describe("Which warm-memory file to update."),
    search: z.string().describe("Substring to match against entries.")
  }
}, async ({ target, search }) => ({
  content: [{ type: "text", text: await removeMemoryEntry(target, search) }]
}));
server.registerTool("memory_show", {
  description: "Show current MEMORY.md and USER.md contents and usage.",
  inputSchema: {
    target: z.enum(["memory", "user"]).optional().describe("Optional single target to inspect.")
  }
}, async ({ target }) => ({
  content: [{ type: "text", text: await formatMemoryShow(target) }]
}));
var transport = new StdioServerTransport;
process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
await server.connect(transport);
sendLog("ready");
