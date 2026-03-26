import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import type { GhostState, SessionInfo, SessionListResponse } from "../types";

type SidebarProps = {
  ghosts: Array<{ name: string; ghost: GhostState }>;
  selectedGhostName: string | null;
  sessions: SessionListResponse | null;
  sessionsError: string | null;
  sessionsLoading: boolean;
  isFocused: boolean;
  isStreaming: boolean;
  onSelectGhost: (name: string) => void;
  onSwitchSession: (sessionId: string) => Promise<void> | void;
  onSpawn: () => void;
};

type SidebarItem =
  | { kind: "ghost"; key: string; ghostName: string; ghost: GhostState }
  | { kind: "session"; key: string; ghostName: string; session: SessionInfo; isCurrent: boolean }
  | { kind: "spawn"; key: "spawn" };

const getSessionLabel = (session: SessionInfo): string => {
  if (session.name && session.name.trim().length > 0) {
    return session.name.trim();
  }

  return session.id.slice(0, 12);
};

export const Sidebar = ({
  ghosts,
  selectedGhostName,
  sessions,
  sessionsError,
  sessionsLoading,
  isFocused,
  isStreaming,
  onSelectGhost,
  onSwitchSession,
  onSpawn
}: SidebarProps) => {
  const items = useMemo<SidebarItem[]>(() => {
    const nextItems: SidebarItem[] = [];

    for (const entry of ghosts) {
      nextItems.push({
        kind: "ghost",
        key: `ghost:${entry.name}`,
        ghostName: entry.name,
        ghost: entry.ghost
      });

      if (entry.name !== selectedGhostName || !sessions) {
        continue;
      }

      for (const session of sessions.sessions) {
        nextItems.push({
          kind: "session",
          key: `session:${session.id}`,
          ghostName: entry.name,
          session,
          isCurrent: session.id === sessions.current
        });
      }
    }

    nextItems.push({ kind: "spawn", key: "spawn" });
    return nextItems;
  }, [ghosts, selectedGhostName, sessions]);

  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (items.length === 0) {
      setCursor(0);
      return;
    }

    setCursor((value) => Math.max(0, Math.min(value, items.length - 1)));
  }, [items]);

  useInput(async (_input, key) => {
    if (!isFocused || isStreaming || items.length === 0) {
      return;
    }

    if (key.upArrow) {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }

    if (key.downArrow) {
      setCursor((value) => Math.min(items.length - 1, value + 1));
      return;
    }

    if (!key.return) {
      return;
    }

    const item = items[cursor];
    if (!item) {
      return;
    }

    if (item.kind === "ghost") {
      onSelectGhost(item.ghostName);
      return;
    }

    if (item.kind === "session") {
      await onSwitchSession(item.session.id);
      return;
    }

    onSpawn();
  });

  return (
    <Box borderStyle="single" borderColor={isFocused ? "cyan" : "gray"} flexDirection="column" width="30%" paddingX={1}>
      <Text bold>GHOSTS</Text>
      <Box flexDirection="column" marginTop={1}>
        {ghosts.length === 0 ? (
          <Text color="gray">No ghosts found.</Text>
        ) : (
          items.map((item, index) => {
            const isActive = isFocused && cursor === index;

            if (item.kind === "ghost") {
              const marker = item.ghost.status === "running" ? "●" : "●";
              const markerColor = item.ghost.status === "running" ? "green" : "gray";

              return (
                <Box key={item.key}>
                  <Text color={isActive ? "cyan" : undefined}>
                    {isActive ? ">" : " "} <Text color={markerColor}>{marker}</Text> {item.ghostName}
                  </Text>
                </Box>
              );
            }

            if (item.kind === "session") {
              const prefix = item.isCurrent ? "*" : "-";
              return (
                <Box key={item.key} marginLeft={2}>
                  <Text color={isActive ? "cyan" : "gray"}>
                    {isActive ? ">" : " "} {prefix} {getSessionLabel(item.session)}
                  </Text>
                </Box>
              );
            }

            return (
              <Box key={item.key} marginTop={1}>
                <Text color={isActive ? "cyan" : "green"}>{isActive ? ">" : " "} [+ Spawn]</Text>
              </Box>
            );
          })
        )}
      </Box>
      {selectedGhostName ? (
        <Box flexDirection="column" marginTop={1}>
          {sessionsLoading ? <Text color="gray">Loading sessions...</Text> : null}
          {!sessionsLoading && sessionsError ? <Text color="yellow">{sessionsError}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
};
