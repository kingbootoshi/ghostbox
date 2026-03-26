import { Box, Text } from "ink";

import type { GhostState, GhostStats } from "../types";
import { ChatInput } from "./input";

export type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "result";
  text: string;
  toolName?: string;
};

type ChatPaneProps = {
  ghost: { name: string; ghost: GhostState } | null;
  currentSessionLabel: string | null;
  messages: ChatItem[];
  stats: GhostStats | null;
  isFocused: boolean;
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  onSubmit: (value: string) => Promise<void> | void;
};

const labelByRole: Record<ChatItem["role"], string> = {
  user: "[you]",
  assistant: "[assistant]",
  system: "[system]",
  tool: "[tool]",
  result: "[result]"
};

const colorByRole: Record<ChatItem["role"], string> = {
  user: "cyan",
  assistant: "green",
  system: "yellow",
  tool: "magenta",
  result: "gray"
};

export const ChatPane = ({
  ghost,
  currentSessionLabel,
  messages,
  stats,
  isFocused,
  isStreaming,
  isLoading,
  error,
  onSubmit
}: ChatPaneProps) => {
  const header = ghost ? `${ghost.name}${currentSessionLabel ? ` > ${currentSessionLabel}` : ""}` : "No ghost selected";
  const model = stats?.model ?? ghost?.ghost.model ?? null;
  const visibleMessages = messages.slice(-18);
  const inputDisabled = !ghost || ghost.ghost.status !== "running" || isLoading;

  return (
    <Box borderStyle="single" borderColor={isFocused ? "cyan" : "gray"} flexDirection="column" width="70%" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{header}</Text>
        <Text color="gray">{model ?? "unknown model"}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {!ghost ? <Text color="gray">Select a ghost from the sidebar.</Text> : null}
        {ghost && ghost.ghost.status !== "running" ? <Text color="yellow">This ghost is stopped.</Text> : null}
        {ghost && isLoading ? <Text color="gray">Loading chat...</Text> : null}
        {ghost && !isLoading && error ? <Text color="yellow">{error}</Text> : null}
        {ghost && !isLoading && !error && visibleMessages.length === 0 ? (
          <Text color="gray">No messages yet.</Text>
        ) : null}
        {visibleMessages.map((message) => {
          const suffix = message.toolName ? ` ${message.toolName}` : "";
          return (
            <Box key={message.id} flexDirection="column" marginBottom={1}>
              <Text color={colorByRole[message.role]}>
                {labelByRole[message.role]}
                {suffix}
              </Text>
              <Text>{message.text}</Text>
            </Box>
          );
        })}
      </Box>
      <ChatInput
        disabled={inputDisabled || isStreaming}
        isFocused={isFocused}
        isStreaming={isStreaming}
        onSubmit={onSubmit}
      />
    </Box>
  );
};
