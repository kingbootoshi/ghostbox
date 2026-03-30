import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { getGhost } from "./orchestrator";
import type { VaultEntry } from "./types";
import { isNodeError } from "./utils";
import { getVaultPath } from "./vault";

type ApiStatusCode = 400 | 404;

const createApiError = (status: ApiStatusCode, message: string): Error & { status: ApiStatusCode } => {
  const error = new Error(message) as Error & { status: ApiStatusCode };
  error.name = "ApiError";
  error.status = status;
  return error;
};

const ensureGhostExists = async (name: string): Promise<string> => {
  await getGhost(name);
  return resolve(getVaultPath(name));
};

const toVaultApiPath = (vaultPath: string, fullPath: string): string => {
  const nextRelativePath = relative(vaultPath, fullPath);
  if (!nextRelativePath) {
    return "/";
  }

  return `/${nextRelativePath.split(sep).join("/")}`;
};

const resolveVaultItemPath = async (
  ghostName: string,
  inputPath: string | undefined,
  options?: { allowRoot?: boolean }
): Promise<{ vaultPath: string; fullPath: string; apiPath: string }> => {
  const vaultPath = await ensureGhostExists(ghostName);
  const rawPath = inputPath?.trim() ?? "";
  const requestedPath = rawPath || "/";

  if (!rawPath && options?.allowRoot !== true) {
    throw createApiError(400, "Missing path");
  }

  if (requestedPath.includes("..")) {
    throw createApiError(400, "Invalid path");
  }

  const relativePath = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = resolve(vaultPath, relativePath);
  const vaultPrefix = vaultPath.endsWith(sep) ? vaultPath : `${vaultPath}${sep}`;

  if (fullPath !== vaultPath && !fullPath.startsWith(vaultPrefix)) {
    throw createApiError(400, "Invalid path");
  }

  if (fullPath === vaultPath && options?.allowRoot !== true) {
    throw createApiError(400, "Invalid path");
  }

  return {
    vaultPath,
    fullPath,
    apiPath: toVaultApiPath(vaultPath, fullPath)
  };
};

const getVaultEntryType = (stats: Awaited<ReturnType<typeof stat>>): VaultEntry["type"] => {
  return stats.isDirectory() ? "directory" : "file";
};

const readVaultEntries = async (vaultPath: string, directoryPath: string): Promise<VaultEntry[]> => {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });

  const entries = await Promise.all(
    directoryEntries.map(async (entry) => {
      const entryPath = resolve(directoryPath, entry.name);
      const entryStats = await stat(entryPath);
      const entryType = getVaultEntryType(entryStats);

      return {
        name: entry.name,
        path: toVaultApiPath(vaultPath, entryPath),
        type: entryType,
        size: entryType === "file" ? entryStats.size : undefined,
        modified: entryStats.mtime.toISOString()
      } satisfies VaultEntry;
    })
  );

  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
};

const throwVaultFsError = (error: unknown): never => {
  if (isNodeError(error) && error.code === "ENOENT") {
    throw createApiError(404, "Path not found");
  }

  throw error;
};

export const listVaultDirectory = async (
  ghostName: string,
  inputPath: string | undefined
): Promise<{ entries: VaultEntry[] }> => {
  try {
    const { vaultPath, fullPath } = await resolveVaultItemPath(ghostName, inputPath, { allowRoot: true });
    const directoryStats = await stat(fullPath);

    if (!directoryStats.isDirectory()) {
      throw createApiError(400, "Path must be a directory");
    }

    return { entries: await readVaultEntries(vaultPath, fullPath) };
  } catch (error) {
    return throwVaultFsError(error);
  }
};

export const readVaultFile = async (
  ghostName: string,
  inputPath: string | undefined
): Promise<{ path: string; content: string; size: number }> => {
  try {
    const { fullPath, apiPath } = await resolveVaultItemPath(ghostName, inputPath);
    const fileStats = await stat(fullPath);

    if (!fileStats.isFile()) {
      throw createApiError(400, "Path must be a file");
    }

    return {
      path: apiPath,
      content: await readFile(fullPath, "utf8"),
      size: fileStats.size
    };
  } catch (error) {
    return throwVaultFsError(error);
  }
};

export const writeVaultFile = async (
  ghostName: string,
  inputPath: string | undefined,
  content: string | null
): Promise<{ path: string; size: number }> => {
  if (content === null) {
    throw createApiError(400, "Missing content");
  }

  const { fullPath, apiPath } = await resolveVaultItemPath(ghostName, inputPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  const fileStats = await stat(fullPath);

  return {
    path: apiPath,
    size: fileStats.size
  };
};

export const deleteVaultFile = async (
  ghostName: string,
  inputPath: string | undefined
): Promise<{ path: string; status: "deleted" }> => {
  try {
    const { fullPath, apiPath } = await resolveVaultItemPath(ghostName, inputPath);
    const fileStats = await stat(fullPath);

    if (!fileStats.isFile()) {
      throw createApiError(400, "Path must be a file");
    }

    const { exitCode, stderr: trashStdErr } = await new Promise<{ exitCode: number; stderr: string }>(
      (resolve, reject) => {
        const proc = nodeSpawn("trash", [fullPath], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
      }
    );

    if (exitCode !== 0) {
      throw new Error(`Trash command failed: ${trashStdErr.trim()}`);
    }

    return { path: apiPath, status: "deleted" };
  } catch (error) {
    return throwVaultFsError(error);
  }
};
