import { homedir } from "node:os";

export const getHomeDirectory = (): string => process.env.HOME ?? homedir();

export const isNodeError = (value: unknown): value is { code?: string } => {
  return typeof value === "object" && value !== null && "code" in value;
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
