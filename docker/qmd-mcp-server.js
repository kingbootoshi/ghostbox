// docker/qmd-mcp-server.ts
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
var QMD_BIN = "/usr/local/bin/qmd";
var EXEC_TIMEOUT_MS = 1e4;
var server = new McpServer({
  name: "qmd",
  version: "1.0.0"
});
var run = (args) => new Promise((resolve, reject) => {
  execFile(QMD_BIN, args, { timeout: EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || error.message));
      return;
    }
    resolve(stdout);
  });
});
server.tool("vault_search", "Search vault files by content. Fast keyword search across all files in the vault.", { query: z.string().describe("Search query"), type: z.string().optional().describe("File type filter (e.g. md, json, ts)") }, async ({ query, type }) => {
  const args = ["search", query];
  if (type)
    args.push("--type", type);
  const result = await run(args);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_read", "Read a vault file. Optionally extract a specific section by heading.", { path: z.string().describe("File path relative to vault root"), section: z.string().optional().describe("Heading text to extract a specific section") }, async ({ path, section }) => {
  const args = ["read", path];
  if (section)
    args.push("--section", section);
  const result = await run(args);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_list", "List files in the vault matching a glob pattern.", { pattern: z.string().optional().describe("Glob pattern to filter files (default: *)") }, async ({ pattern }) => {
  const args = ["list"];
  if (pattern)
    args.push(pattern);
  const result = await run(args);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_tree", "Show the vault directory structure as a tree.", { depth: z.number().optional().describe("Max directory depth (default: 3)") }, async ({ depth }) => {
  const args = ["tree"];
  if (depth !== undefined)
    args.push(String(depth));
  const result = await run(args);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_summary", "Quick overview of vault contents: file counts, sizes, directories, and memory state.", {}, async () => {
  const result = await run(["summary"]);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_recent", "Show the most recently modified files in the vault.", { count: z.number().optional().describe("Number of files to show (default: 10)") }, async ({ count }) => {
  const args = ["recent"];
  if (count !== undefined)
    args.push(String(count));
  const result = await run(args);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_scan", "List all vault files with their first heading or first line as a summary.", {}, async () => {
  const result = await run(["scan"]);
  return { content: [{ type: "text", text: result }] };
});
server.tool("vault_headings", "Show all markdown headings in a file. Useful for navigating long documents.", { path: z.string().describe("File path relative to vault root") }, async ({ path }) => {
  const result = await run(["headings", path]);
  return { content: [{ type: "text", text: result }] };
});
var transport = new StdioServerTransport;
await server.connect(transport);
