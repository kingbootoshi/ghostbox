import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./logger";
import { getHomeDirectory } from "./utils";

type GitStatus = string;
const log = createLogger("vault");

const getVaultPathFromName = (name: string): string => {
  return join(getHomeDirectory(), ".ghostbox", "ghosts", name, "vault");
};

export const getVaultPath = getVaultPathFromName;

const getGhostBranchName = (name: string): string => `ghost/${name}`;

const buildInitialClaudeContent = (name: string): string => `# Ghost: ${name}

You are a persistent agent. Your vault at /vault is where long-term context lives.

## Memory

Two files are loaded into your system prompt each session:
- \`/vault/MEMORY.md\` - your working memory, notes, decisions, and reminders
- \`/vault/USER.md\` - who the user is, their preferences, and stable facts about them

Use these MCP tools to maintain memory:
- \`mcp__ghostbox__memory_write\` - append new facts to MEMORY.md or USER.md
- \`mcp__ghostbox__memory_show\` - inspect current memory contents and usage

Write concise, durable facts. Use MEMORY.md for project and environment notes. Use USER.md for facts about the user.

## Communication And Scheduling

Use \`mcp__ghostbox__mailbox\` to check mail, read messages, send messages, and reply.
Use \`mcp__ghostbox__schedule\` to create, list, and delete scheduled prompts that should persist across sessions.

Check your mailbox when a session starts and during long-running work.

## Vault Layout

- \`/vault/knowledge/\` - research, findings, and reference notes
- \`/vault/code/\` - scripts, prototypes, and project files
- \`/vault/CLAUDE.md\` - this file

Write detailed findings into files under the vault, then save the important takeaway to MEMORY.md.

## CLI Tools

You can use normal shell commands plus these helpers:
- \`ghost-save "message"\` - save and push vault changes
- \`ghost-changelog\` - inspect recent vault changes
- \`qmd\` - search and read vault notes
- \`exa-search\` - web search from the command line when external research is needed

## Working Style

- Read memory before answering questions that may depend on prior context
- Save important facts, decisions, and follow-ups before context is lost
- Keep this file accurate if your role or instructions change
- Everything in /vault persists across sessions
`;

const runCommand = async (name: string, cwd: string, command: string, args: string[]): Promise<GitStatus> => {
  const op = [command, ...args].join(" ");
  log.info({ name, op }, "Vault operation");

  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const proc = nodeSpawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: out, stderr: err }));
  });

  if (exitCode !== 0) {
    const stderrText = stderr.trim();
    log.error({ name, op, stderr: stderrText, exitCode }, "Vault git command failed");
    throw new Error(`${op} failed: ${stderrText}`);
  }

  return stdout;
};

const runGit = async (name: string, vaultPath: string, args: string[]): Promise<GitStatus> => {
  return runCommand(name, vaultPath, "git", args);
};

const withGitToken = (remote: string, token: string): string => {
  const trimmed = remote.trim();
  if (!trimmed.startsWith("https://")) {
    return trimmed;
  }

  return trimmed.replace(/^https:\/\//, `https://${token}@`);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const configureGitIdentity = async (name: string, vaultPath: string): Promise<void> => {
  await runGit(name, vaultPath, ["config", "user.name", name]);
  await runGit(name, vaultPath, ["config", "user.email", `${name}@ghostbox.local`]);
};

const ensureRemote = async (name: string, vaultPath: string, remoteName: string, remoteUrl: string): Promise<void> => {
  const remotes = (await runGit(name, vaultPath, ["remote"])).trim().split("\n").filter(Boolean);
  if (remotes.includes(remoteName)) {
    await runGit(name, vaultPath, ["remote", "set-url", remoteName, remoteUrl]);
  } else {
    await runGit(name, vaultPath, ["remote", "add", remoteName, remoteUrl]);
  }
};

export const initVault = async (name: string): Promise<void> => {
  const vaultPath = getVaultPath(name);
  const branchName = getGhostBranchName(name);

  await mkdir(vaultPath, { recursive: true });
  await runGit(name, vaultPath, ["init", "-b", "main"]);
  await configureGitIdentity(name, vaultPath);

  await writeFile(join(vaultPath, ".gitignore"), `${["node_modules/", ".env", "*.tmp", ".DS_Store"].join("\n")}\n`);
  await writeFile(join(vaultPath, "CLAUDE.md"), buildInitialClaudeContent(name));
  await mkdir(join(vaultPath, "knowledge"), { recursive: true });
  await mkdir(join(vaultPath, "code"), { recursive: true });
  await writeFile(join(vaultPath, "knowledge", ".gitkeep"), "");
  await writeFile(join(vaultPath, "code", ".gitkeep"), "");
  await writeFile(join(vaultPath, "MEMORY.md"), "");
  await writeFile(join(vaultPath, "USER.md"), "");

  await runGit(name, vaultPath, ["add", "-A"]);
  await runGit(name, vaultPath, ["commit", "-m", "Initialize vault"]);

  await runGit(name, vaultPath, ["checkout", "-b", branchName]);
  await mkdir(join(vaultPath, ".pi", "extensions"), { recursive: true });
  await writeFile(join(vaultPath, ".pi", "extensions", ".gitkeep"), "");
  await runCommand(name, vaultPath, "ln", ["-s", "CLAUDE.md", "AGENTS.md"]);
  await runGit(name, vaultPath, ["add", "-A"]);
  await runGit(name, vaultPath, ["commit", "-m", "Set up ghost branch"]);
};

export const pullVault = async (name: string, remote: string, token: string): Promise<string> => {
  const vaultPath = getVaultPath(name);
  const remoteUrl = withGitToken(remote, token);
  const remoteName = "ghostbox";
  const branchName = getGhostBranchName(name);

  if (!(await pathExists(vaultPath))) {
    await mkdir(dirname(vaultPath), { recursive: true });
    await runCommand(name, dirname(vaultPath), "git", [
      "clone",
      "--branch",
      branchName,
      "--single-branch",
      remoteUrl,
      vaultPath
    ]);
    await configureGitIdentity(name, vaultPath);
    await ensureRemote(name, vaultPath, remoteName, remoteUrl);
    return vaultPath;
  }

  await configureGitIdentity(name, vaultPath);
  await ensureRemote(name, vaultPath, remoteName, remoteUrl);
  await runGit(name, vaultPath, ["fetch", remoteName, branchName]);

  const localBranch = (await runGit(name, vaultPath, ["branch", "--list", branchName])).trim();
  if (localBranch.length > 0) {
    await runGit(name, vaultPath, ["checkout", branchName]);
  } else {
    await runGit(name, vaultPath, ["checkout", "-b", branchName, "--track", `${remoteName}/${branchName}`]);
  }

  await runGit(name, vaultPath, ["pull", remoteName, branchName]);
  return vaultPath;
};

export const commitVault = async (name: string, message?: string): Promise<string> => {
  const vaultPath = getVaultPath(name);
  const commitMessage = message?.trim() || "Ghost auto-save";

  await runGit(name, vaultPath, ["add", "-A"]);
  const status = (await runGit(name, vaultPath, ["status", "--porcelain"])).trim();
  if (status.length === 0) {
    return "";
  }

  await runGit(name, vaultPath, ["commit", "-m", commitMessage]);
  return (await runGit(name, vaultPath, ["rev-parse", "HEAD"])).trim();
};

export const pushVault = async (name: string, remote: string, token: string): Promise<void> => {
  const vaultPath = getVaultPath(name);
  const remoteUrl = withGitToken(remote, token);
  const remoteName = "ghostbox";
  const branchName = getGhostBranchName(name);

  await ensureRemote(name, vaultPath, remoteName, remoteUrl);

  await runGit(name, vaultPath, ["push", remoteName, branchName]);
};

export const mergeVaults = async (source: string, target: string): Promise<string> => {
  const targetPath = getVaultPath(target);
  const sourcePath = getVaultPath(source);
  const remoteName = "ghostbox-source";
  try {
    await runGit(target, targetPath, ["remote", "add", remoteName, sourcePath]);
    await runGit(target, targetPath, ["fetch", remoteName]);
    return (await runGit(target, targetPath, ["merge", "--allow-unrelated-histories", "FETCH_HEAD"])).trim();
  } finally {
    await runGit(target, targetPath, ["remote", "remove", remoteName]).catch(() => undefined);
  }
};

export const getVaultStatus = async (
  name: string
): Promise<{ dirty: boolean; commitCount: number; lastCommit: string }> => {
  const vaultPath = getVaultPath(name);
  const statusText = (await runGit(name, vaultPath, ["status", "--porcelain"])).trim();
  const commitCountText = (await runGit(name, vaultPath, ["rev-list", "--count", "HEAD"])).trim();
  const lastCommit = (await runGit(name, vaultPath, ["log", "-1", "--format=%ci"])).trim();

  return {
    dirty: statusText.length > 0,
    commitCount: Number.parseInt(commitCountText, 10),
    lastCommit
  };
};
