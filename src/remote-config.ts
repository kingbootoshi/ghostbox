import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getHomeDirectory, isNodeError } from "./utils";

export type ConnectionConfig = {
  url?: string;
  token?: string;
};

export type RemoteConfig = ConnectionConfig;

const REMOTE_CONFIG_DIRECTORY_MODE = 0o700;
const REMOTE_CONFIG_FILE_MODE = 0o600;

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeConnectionConfig = (value: unknown): ConnectionConfig => {
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
  return join(getHomeDirectory(), ".ghostbox", "connection.json");
};

const ensureRemoteConfigDirectory = async (path: string): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: REMOTE_CONFIG_DIRECTORY_MODE });
  await chmod(directory, REMOTE_CONFIG_DIRECTORY_MODE);
};

const getLegacyRemoteConfigPath = (): string => {
  return join(getHomeDirectory(), ".ghostbox", "remote.json");
};

const readConfigFile = async (path: string): Promise<ConnectionConfig | null> => {
  try {
    const contents = await readFile(path, "utf8");
    return normalizeConnectionConfig(JSON.parse(contents) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const removeFileIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
};

const writeRemoteConfig = async (config: ConnectionConfig): Promise<ConnectionConfig> => {
  const normalized = normalizeConnectionConfig(config);
  const path = getRemoteConfigPath();
  await ensureRemoteConfigDirectory(path);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await chmod(path, REMOTE_CONFIG_FILE_MODE);
  return normalized;
};

const migrateLegacyRemoteConfig = async (): Promise<ConnectionConfig | null> => {
  const legacyConfig = await readConfigFile(getLegacyRemoteConfigPath());
  if (legacyConfig === null) {
    return null;
  }

  const migratedConfig = await writeRemoteConfig(legacyConfig);
  await removeFileIfPresent(getLegacyRemoteConfigPath());
  return migratedConfig;
};

export const readRemoteConfig = async (): Promise<ConnectionConfig | null> => {
  const currentConfig = await readConfigFile(getRemoteConfigPath());
  if (currentConfig !== null) {
    return currentConfig;
  }

  return migrateLegacyRemoteConfig();
};

export const updateRemoteConfig = async (updates: ConnectionConfig): Promise<ConnectionConfig> => {
  const current = (await readRemoteConfig()) ?? {};
  return writeRemoteConfig({
    ...current,
    ...updates
  });
};

export const clearRemoteConfig = async (): Promise<void> => {
  await removeFileIfPresent(getRemoteConfigPath());
  await removeFileIfPresent(getLegacyRemoteConfigPath());
};
