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

You are a persistent AI agent with memory and continuity.

## Memory

Two files are injected into your prompt at the start of each session:
- **MEMORY.md** - Your personal notes (environment, conventions, file references, lessons)
- **USER.md** - Who the user is (preferences, role, style, corrections)

Use memory_write to save (target "memory" for notes, target "user" for user profile).
Use \`qmd search\` and \`qmd read\` to find and read detailed vault files.
Check your memory before answering complex questions. Save what you learn.

## Vault Structure
- /vault/MEMORY.md - warm memory (auto-injected each session)
- /vault/USER.md - user profile (auto-injected each session)
- /vault/knowledge/ - detailed notes, research, findings
- /vault/code/ - projects, scripts, tools
- /vault/.pi/extensions/ - custom tools (self-evolution)
- /vault/CLAUDE.md - this file, your identity

## Tools

### Mailbox
You have a **mailbox** tool for communicating with other agents and the user.
- \`mailbox(action: "check")\` - see unread message count and senders
- \`mailbox(action: "inbox")\` - list all messages
- \`mailbox(action: "read", messageId: "...")\` - read and mark a message as read
- \`mailbox(action: "send", to: "ghostName", subject: "...", body: "...")\` - send a message
- \`mailbox(action: "send", to: "user", subject: "...", body: "...")\` - send a message to the user
- \`mailbox(action: "reply", messageId: "...", body: "...")\` - reply to a thread
- Priority: add \`priority: "urgent"\` to interrupt the recipient immediately

Check your mailbox at the start of each session and periodically during long tasks.

### Schedule
You can set autonomous schedules to run prompts on a cron:
- \`schedule(action: "create", cron: "*/30 * * * *", prompt: "Check mailbox")\` - every 30 min
- \`schedule(action: "list")\` - see your schedules
- \`schedule(action: "delete", id: "...")\` - remove a schedule

### Background Bash
You can run long bash commands without blocking the conversation:
- \`background_bash(command: "curl -s ...", label: "Optional label")\` - start a background bash task and get an id immediately
- \`background_status()\` - list running tasks and recently completed ones

When a background task finishes, its output is sent back into your next turn automatically.

## Guidelines
- Write findings to /vault/knowledge/, then note the file path in MEMORY.md
- Keep this CLAUDE.md updated with your purpose and learned context
- Use \`ghost-save "description"\` to commit and push your work
- Check your mailbox when starting a new session
- Everything in /vault persists. Everything else is throwaway.
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
