import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getHomeDirectory, isNodeError } from "./utils";

export type RemoteConfig = {
  url?: string;
  token?: string;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeRemoteConfig = (value: unknown): RemoteConfig => {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const url = normalizeOptionalString(record.url);
  const token = normalizeOptionalString(record.token);

  return {
    ...(url ? { url } : {}),
    ...(token ? { token } : {})
  };
};

export const getRemoteConfigPath = (): string => {
  return join(getHomeDirectory(), ".ghostbox", "remote.json");
};

export const readRemoteConfig = async (): Promise<RemoteConfig | null> => {
  try {
    const contents = await readFile(getRemoteConfigPath(), "utf8");
    return normalizeRemoteConfig(JSON.parse(contents) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

export const writeRemoteConfig = async (config: RemoteConfig): Promise<RemoteConfig> => {
  const normalized = normalizeRemoteConfig(config);
  const path = getRemoteConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
};

export const updateRemoteConfig = async (updates: RemoteConfig): Promise<RemoteConfig> => {
  const current = (await readRemoteConfig()) ?? {};
  return writeRemoteConfig({
    ...current,
    ...updates
  });
};

export const clearRemoteConfig = async (): Promise<void> => {
  try {
    await unlink(getRemoteConfigPath());
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
};
