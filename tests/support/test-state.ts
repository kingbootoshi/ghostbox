import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GhostboxConfig, GhostboxState, GhostState } from "../../src/types";

export const createConfig = (overrides: Partial<GhostboxConfig> = {}): GhostboxConfig => ({
  telegramToken: "telegram-token-1234567890",
  githubToken: "github-token-1234567890",
  githubRemote: "https://github.com/example/repo.git",
  defaultModel: "anthropic/claude-sonnet-4-6",
  defaultProvider: "anthropic",
  imageName: "ghostbox-agent",
  imageVersion: "gb-deadbeef",
  observerModel: "openai/gpt-4o-mini",
  ...overrides
});

export const createGhostState = (overrides: Partial<GhostState> = {}): GhostState => ({
  containerId: "container-1",
  portBase: 3100,
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  imageVersion: "gb-deadbeef",
  status: "running",
  createdAt: "2026-03-25T00:00:00.000Z",
  systemPrompt: null,
  apiKeys: [
    {
      id: "key-1",
      key: "gbox_1234567890abcdef",
      label: "default",
      createdAt: "2026-03-25T00:00:00.000Z"
    }
  ],
  ...overrides
});

export const createState = (overrides: Partial<GhostboxState> = {}): GhostboxState => ({
  ghosts: {},
  config: createConfig(),
  telegram: { activeChatGhosts: {} },
  ...overrides
});

const removeTempDir = async (path: string): Promise<void> => {
  // Use trash locally for safety, fall back to rm for CI where trash isn't installed
  const cmd = await Bun.spawn(["which", "trash"], { stdout: "ignore", stderr: "ignore" }).exited === 0
    ? ["trash", path]
    : ["rm", "-rf", path];
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to remove ${path}: ${stderr.trim()}`);
  }
};

export const createTestHome = async (
  state = createState()
): Promise<{
  homeDir: string;
  statePath: string;
  writeState: (nextState: GhostboxState | unknown) => Promise<void>;
  createVaultFile: (ghostName: string, relativePath: string, content: string) => Promise<string>;
  cleanup: () => Promise<void>;
}> => {
  const homeDir = await mkdtemp(join(tmpdir(), "ghostbox-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  const statePath = join(homeDir, ".ghostbox", "state.json");
  await mkdir(join(homeDir, ".ghostbox"), { recursive: true });

  const writeState = async (nextState: GhostboxState | unknown): Promise<void> => {
    await writeFile(statePath, JSON.stringify(nextState, null, 2));
  };

  const createVaultFile = async (ghostName: string, relativePath: string, content: string): Promise<string> => {
    const fullPath = join(homeDir, ".ghostbox", "ghosts", ghostName, "vault", relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  };

  await writeState(state);

  return {
    homeDir,
    statePath,
    writeState,
    createVaultFile,
    cleanup: async () => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      await removeTempDir(homeDir);
    }
  };
};
