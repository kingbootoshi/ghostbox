import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger';

type GitStatus = string;
const log = createLogger('vault');

const getHomeDirectory = (): string => process.env.HOME ?? homedir();

const getVaultPathFromName = (name: string): string => {
  return join(getHomeDirectory(), '.ghostbox', 'ghosts', name, 'vault');
};

export const getVaultPath = getVaultPathFromName;

const getGhostBranchName = (name: string): string => `ghost/${name}`;

const buildInitialClaudeContent = (name: string): string => `# Ghost: ${name}

You are a persistent AI agent with memory and continuity in this vault.

## Vault Structure
- /vault/knowledge/ - persistent memory, research notes, findings
- /vault/code/ - projects, scripts, tools
- /vault/.pi/extensions/ - Pi agent extensions (your self-evolution layer)
- /vault/CLAUDE.md - this file, your identity and instructions (AGENTS.md is symlinked to this)

## Self-Evolution
You can extend your own capabilities by writing TypeScript extensions to /vault/.pi/extensions/.
Extensions are loaded on startup and can register new tools, commands, and hooks.
See the Pi extension API: export default (pi) => { pi.registerTool({...}) }

When you write an extension, it persists in your vault and survives restarts.
Your extensions ARE your growth - they compound over sessions.

## Guidelines
- Write important findings to /vault/knowledge/
- Keep this CLAUDE.md updated with your purpose and learned context
- Create reusable tools as Pi extensions, not bash scripts
- Run \`ghost-save "description"\` to commit and push your work to GitHub
- Save at meaningful milestones, not every file change
- Everything in /vault persists. Everything else is throwaway.
`;

const runCommand = async (
  name: string,
  cwd: string,
  command: string,
  args: string[],
): Promise<GitStatus> => {
  const op = [command, ...args].join(' ');
  log.info({ name, op }, 'Vault operation');

  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderrText = stderr.trim();
    log.error({ name, op, stderr: stderrText, exitCode }, 'Vault git command failed');
    throw new Error(`${op} failed: ${stderrText}`);
  }

  return stdout;
};

const runGit = async (
  name: string,
  vaultPath: string,
  args: string[],
): Promise<GitStatus> => {
  return runCommand(name, vaultPath, 'git', args);
};

const withGitToken = (remote: string, token: string): string => {
  const trimmed = remote.trim();
  if (!trimmed.startsWith('https://')) {
    return trimmed;
  }

  return trimmed.replace(/^https:\/\//, `https://${token}@`);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const configureGitIdentity = async (name: string, vaultPath: string): Promise<void> => {
  await runGit(name, vaultPath, ['config', 'user.name', name]);
  await runGit(name, vaultPath, ['config', 'user.email', `${name}@ghostbox.local`]);
};

const ensureRemote = async (
  name: string,
  vaultPath: string,
  remoteName: string,
  remoteUrl: string,
): Promise<void> => {
  const remotes = (await runGit(name, vaultPath, ['remote'])).trim().split('\n').filter(Boolean);
  if (remotes.includes(remoteName)) {
    await runGit(name, vaultPath, ['remote', 'set-url', remoteName, remoteUrl]);
  } else {
    await runGit(name, vaultPath, ['remote', 'add', remoteName, remoteUrl]);
  }
};

export const initVault = async (name: string): Promise<void> => {
  const vaultPath = getVaultPath(name);
  const branchName = getGhostBranchName(name);

  await mkdir(vaultPath, { recursive: true });
  await runGit(name, vaultPath, ['init', '-b', 'main']);
  await configureGitIdentity(name, vaultPath);

  await Bun.write(
    join(vaultPath, '.gitignore'),
    ['node_modules/', '.env', '*.tmp', '.DS_Store'].join('\n') + '\n',
  );
  await Bun.write(join(vaultPath, 'CLAUDE.md'), buildInitialClaudeContent(name));
  await mkdir(join(vaultPath, 'knowledge'), { recursive: true });
  await mkdir(join(vaultPath, 'code'), { recursive: true });
  await Bun.write(join(vaultPath, 'knowledge', '.gitkeep'), '');
  await Bun.write(join(vaultPath, 'code', '.gitkeep'), '');

  await runGit(name, vaultPath, ['add', '-A']);
  await runGit(name, vaultPath, ['commit', '-m', 'Initialize vault']);

  await runGit(name, vaultPath, ['checkout', '-b', branchName]);
  await mkdir(join(vaultPath, '.pi', 'extensions'), { recursive: true });
  await Bun.write(join(vaultPath, '.pi', 'extensions', '.gitkeep'), '');
  await runCommand(name, vaultPath, 'ln', ['-s', 'CLAUDE.md', 'AGENTS.md']);
  await runGit(name, vaultPath, ['add', '-A']);
  await runGit(name, vaultPath, ['commit', '-m', 'Set up ghost branch']);
};

export const pullVault = async (
  name: string,
  remote: string,
  token: string,
): Promise<string> => {
  const vaultPath = getVaultPath(name);
  const remoteUrl = withGitToken(remote, token);
  const remoteName = 'ghostbox';
  const branchName = getGhostBranchName(name);

  if (!(await pathExists(vaultPath))) {
    await mkdir(dirname(vaultPath), { recursive: true });
    await runCommand(name, dirname(vaultPath), 'git', [
      'clone',
      '--branch',
      branchName,
      '--single-branch',
      remoteUrl,
      vaultPath,
    ]);
    await configureGitIdentity(name, vaultPath);
    await ensureRemote(name, vaultPath, remoteName, remoteUrl);
    return vaultPath;
  }

  await configureGitIdentity(name, vaultPath);
  await ensureRemote(name, vaultPath, remoteName, remoteUrl);
  await runGit(name, vaultPath, ['fetch', remoteName, branchName]);

  const localBranch = (await runGit(name, vaultPath, ['branch', '--list', branchName])).trim();
  if (localBranch.length > 0) {
    await runGit(name, vaultPath, ['checkout', branchName]);
  } else {
    await runGit(name, vaultPath, [
      'checkout',
      '-b',
      branchName,
      '--track',
      `${remoteName}/${branchName}`,
    ]);
  }

  await runGit(name, vaultPath, ['pull', remoteName, branchName]);
  return vaultPath;
};

export const commitVault = async (
  name: string,
  message?: string,
): Promise<string> => {
  const vaultPath = getVaultPath(name);
  const commitMessage = message?.trim() || 'Ghost auto-save';

  await runGit(name, vaultPath, ['add', '-A']);
  const status = (await runGit(name, vaultPath, ['status', '--porcelain'])).trim();
  if (status.length === 0) {
    return '';
  }

  await runGit(name, vaultPath, ['commit', '-m', commitMessage]);
  return (await runGit(name, vaultPath, ['rev-parse', 'HEAD'])).trim();
};

export const pushVault = async (
  name: string,
  remote: string,
  token: string,
): Promise<void> => {
  const vaultPath = getVaultPath(name);
  const remoteUrl = withGitToken(remote, token);
  const remoteName = 'ghostbox';
  const branchName = getGhostBranchName(name);

  await ensureRemote(name, vaultPath, remoteName, remoteUrl);

  await runGit(name, vaultPath, ['push', remoteName, branchName]);
};

export const mergeVaults = async (source: string, target: string): Promise<string> => {
  const targetPath = getVaultPath(target);
  const sourcePath = getVaultPath(source);
  const remoteName = 'ghostbox-source';
  try {
    await runGit(target, targetPath, ['remote', 'add', remoteName, sourcePath]);
    await runGit(target, targetPath, ['fetch', remoteName]);
    return (await runGit(target, targetPath, ['merge', '--allow-unrelated-histories', 'FETCH_HEAD']))
      .trim();
  } finally {
    await runGit(target, targetPath, ['remote', 'remove', remoteName]).catch(() => undefined);
  }
}

export const getVaultStatus = async (
  name: string,
): Promise<{ dirty: boolean; commitCount: number; lastCommit: string }> => {
  const vaultPath = getVaultPath(name);
  const statusText = (await runGit(name, vaultPath, ['status', '--porcelain'])).trim();
  const commitCountText = (await runGit(name, vaultPath, ['rev-list', '--count', 'HEAD'])).trim();
  const lastCommit = (await runGit(name, vaultPath, ['log', '-1', '--format=%ci'])).trim();

  return {
    dirty: statusText.length > 0,
    commitCount: Number.parseInt(commitCountText, 10),
    lastCommit,
  };
};
