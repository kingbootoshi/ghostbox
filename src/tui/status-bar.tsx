import { Box, Text } from "ink";

import type { GhostStats } from "../types";

type StatusBarProps = {
  model: string | null;
  stats: GhostStats | null;
  streaming: boolean;
  message: string | null;
};

const formatNumber = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return String(value);
};

export const StatusBar = ({ model, stats, streaming, message }: StatusBarProps) => {
  const contextText = stats?.context
    ? `${formatNumber(stats.context.used)} / ${formatNumber(stats.context.window)}`
    : "n/a";

  const left = model ? `[${model}]` : "[no ghost selected]";
  const middle = `[context ${contextText}]`;
  const right = streaming
    ? "[Esc cancel] [Ctrl+B sidebar] [Ctrl+N new] [Tab focus]"
    : "[Ctrl+B sidebar] [Ctrl+N new] [Tab focus]";

  return (
    <Box borderStyle="single" borderColor="gray" justifyContent="space-between" paddingX={1} paddingY={0}>
      <Text>{left}</Text>
      <Text>{middle}</Text>
      <Text color={message ? "yellow" : "gray"}>{message ?? right}</Text>
    </Box>
  );
};
