import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GhostState, GhostStats, HistoryMessage, SessionInfo, SessionListResponse } from "../types";
import { apiClient } from "./api-client";
import { type ChatItem, ChatPane } from "./chat";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";

type FocusTarget = "sidebar" | "chat";

const mapHistoryMessage = (message: HistoryMessage, index: number): ChatItem => {
  const attachmentText =
    message.attachmentCount && message.attachmentCount > 0 && message.text.length === 0
      ? `${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"}`
      : message.text;

  if (message.role === "user") {
    return { id: `history:${index}`, role: "user", text: attachmentText };
  }

  if (message.role === "assistant") {
    return { id: `history:${index}`, role: "assistant", text: attachmentText };
  }

  if (message.role === "system") {
    return { id: `history:${index}`, role: "system", text: attachmentText };
  }

  if (message.role === "tool_use") {
    return {
      id: `history:${index}`,
      role: "tool",
      text: attachmentText || "{}",
      toolName: message.toolName
    };
  }

  return {
    id: `history:${index}`,
    role: "result",
    text: attachmentText || "{}",
    toolName: message.toolName
  };
};

const toNotice = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Request failed.";
};

const findCurrentSession = (sessions: SessionListResponse | null): SessionInfo | null => {
  if (!sessions) {
    return null;
  }

  return sessions.sessions.find((session) => session.id === sessions.current) ?? null;
};

export const GhostboxTUI = () => {
  const [ghostMap, setGhostMap] = useState<Record<string, GhostState>>({});
  const [selectedGhostName, setSelectedGhostName] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [focus, setFocus] = useState<FocusTarget>("sidebar");
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [sessions, setSessions] = useState<SessionListResponse | null>(null);
  const [stats, setStats] = useState<GhostStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingAbortRef = useRef<AbortController | null>(null);
  const selectedGhostRef = useRef<string | null>(null);

  const ghosts = useMemo(() => {
    return Object.entries(ghostMap)
      .map(([name, ghost]) => ({ name, ghost }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [ghostMap]);

  const selectedGhost = useMemo(() => {
    if (!selectedGhostName) {
      return null;
    }

    const ghost = ghostMap[selectedGhostName];
    if (!ghost) {
      return null;
    }

    return { name: selectedGhostName, ghost };
  }, [ghostMap, selectedGhostName]);

  const currentSession = useMemo(() => {
    return findCurrentSession(sessions);
  }, [sessions]);

  const loadGhosts = useCallback(async () => {
    const nextGhosts = await apiClient.listGhosts();
    setGhostMap(nextGhosts);
  }, []);

  const loadSelectedGhost = useCallback(
    async (name: string) => {
      const ghost = ghostMap[name];
      if (!ghost || ghost.status !== "running") {
        if (selectedGhostRef.current === name) {
          setMessages([]);
          setSessions(null);
          setStats(null);
          setDetailError(null);
          setSessionsError(null);
        }
        return;
      }

      setIsLoading(true);
      setSessionsLoading(true);
      setDetailError(null);
      setSessionsError(null);

      const [historyResult, sessionResult, statsResult] = await Promise.allSettled([
        apiClient.getHistory(name),
        apiClient.getSessions(name),
        apiClient.getStats(name)
      ]);

      if (selectedGhostRef.current !== name) {
        return;
      }

      if (historyResult.status === "fulfilled") {
        setMessages(historyResult.value.messages.map(mapHistoryMessage));
      } else {
        setMessages([]);
        setDetailError(toNotice(historyResult.reason));
      }

      if (sessionResult.status === "fulfilled") {
        setSessions(sessionResult.value);
        setSessionsError(null);
      } else {
        setSessions(null);
        setSessionsError(toNotice(sessionResult.reason));
      }

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value);
      } else {
        setStats(null);
        if (!detailError) {
          setDetailError(toNotice(statsResult.reason));
        }
      }

      setIsLoading(false);
      setSessionsLoading(false);
    },
    [detailError, ghostMap]
  );

  const refreshSelectedGhost = useCallback(async () => {
    if (!selectedGhostRef.current) {
      return;
    }

    await loadSelectedGhost(selectedGhostRef.current);
  }, [loadSelectedGhost]);

  useEffect(() => {
    selectedGhostRef.current = selectedGhostName;
  }, [selectedGhostName]);

  useEffect(() => {
    void loadGhosts().catch((error: unknown) => {
      setStatusMessage(toNotice(error));
    });

    const interval = setInterval(() => {
      void loadGhosts().catch((error: unknown) => {
        setStatusMessage(toNotice(error));
      });
    }, 4_000);

    return () => {
      clearInterval(interval);
    };
  }, [loadGhosts]);

  useEffect(() => {
    if (ghosts.length === 0) {
      setSelectedGhostName(null);
      return;
    }

    if (!selectedGhostName || !(selectedGhostName in ghostMap)) {
      setSelectedGhostName(ghosts[0]?.name ?? null);
    }
  }, [ghostMap, ghosts, selectedGhostName]);

  useEffect(() => {
    if (!selectedGhostName) {
      setMessages([]);
      setSessions(null);
      setStats(null);
      return;
    }

    void loadSelectedGhost(selectedGhostName).catch((error: unknown) => {
      if (selectedGhostRef.current !== selectedGhostName) {
        return;
      }

      setDetailError(toNotice(error));
      setIsLoading(false);
      setSessionsLoading(false);
    });
  }, [loadSelectedGhost, selectedGhostName]);

  useEffect(() => {
    if (!selectedGhostName || !selectedGhost || selectedGhost.ghost.status !== "running" || isStreaming) {
      return;
    }

    const interval = setInterval(() => {
      void refreshSelectedGhost().catch(() => {});
    }, 6_000);

    return () => {
      clearInterval(interval);
    };
  }, [isStreaming, refreshSelectedGhost, selectedGhost, selectedGhostName]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "b") {
      setSidebarVisible((value) => {
        const nextValue = !value;
        if (!nextValue) {
          setFocus("chat");
        }
        return nextValue;
      });
      return;
    }

    if (key.ctrl && _input === "n") {
      if (!selectedGhostName || isStreaming || ghostMap[selectedGhostName]?.status !== "running") {
        return;
      }

      void apiClient
        .newSession(selectedGhostName)
        .then(async () => {
          setStatusMessage("Started a new session.");
          await refreshSelectedGhost();
        })
        .catch((error: unknown) => {
          setStatusMessage(toNotice(error));
        });
      return;
    }

    if (key.tab) {
      if (!sidebarVisible) {
        setFocus("chat");
        return;
      }

      setFocus((value) => (value === "sidebar" ? "chat" : "sidebar"));
      return;
    }

    if (!key.escape) {
      return;
    }

    if (streamingAbortRef.current) {
      streamingAbortRef.current.abort();
      setStatusMessage("Streaming cancelled.");
    }
  });

  const handleSubmit = useCallback(
    async (prompt: string) => {
      if (!selectedGhost || selectedGhost.ghost.status !== "running" || isStreaming) {
        return;
      }

      setFocus("chat");
      setStatusMessage(null);
      setIsStreaming(true);
      setMessages((current) => [
        ...current,
        {
          id: `local:user:${Date.now()}`,
          role: "user",
          text: prompt
        }
      ]);

      const controller = new AbortController();
      streamingAbortRef.current = controller;

      let assistantMessageId: string | null = null;
      let lastAssistantText = "";

      try {
        for await (const message of apiClient.streamMessage(selectedGhost.name, prompt, {
          signal: controller.signal
        })) {
          if (message.type === "assistant") {
            lastAssistantText = message.text;
            if (!assistantMessageId) {
              assistantMessageId = `stream:assistant:${Date.now()}`;
              setMessages((current) => [
                ...current,
                {
                  id: assistantMessageId as string,
                  role: "assistant",
                  text: message.text
                }
              ]);
            } else {
              setMessages((current) =>
                current.map((entry) => (entry.id === assistantMessageId ? { ...entry, text: message.text } : entry))
              );
            }
            continue;
          }

          if (message.type === "tool_use") {
            setMessages((current) => [
              ...current,
              {
                id: `stream:tool:${Date.now()}:${current.length}`,
                role: "tool",
                text: JSON.stringify(message.input ?? {}, null, 2),
                toolName: message.tool
              }
            ]);
            continue;
          }

          if (message.type === "tool_result") {
            setMessages((current) => [
              ...current,
              {
                id: `stream:result:${Date.now()}:${current.length}`,
                role: "result",
                text:
                  typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? {}, null, 2)
              }
            ]);
            continue;
          }

          if (message.type === "result" && message.text && message.text !== lastAssistantText) {
            setMessages((current) => [
              ...current,
              {
                id: `stream:final:${Date.now()}`,
                role: "result",
                text: message.text
              }
            ]);
          }
        }

        await refreshSelectedGhost();
      } catch (error) {
        const notice = toNotice(error);
        setStatusMessage(notice);
        setMessages((current) => [
          ...current,
          {
            id: `stream:error:${Date.now()}`,
            role: "result",
            text: notice
          }
        ]);
      } finally {
        streamingAbortRef.current = null;
        setIsStreaming(false);
      }
    },
    [isStreaming, refreshSelectedGhost, selectedGhost]
  );

  const handleSelectGhost = useCallback(
    (name: string) => {
      if (isStreaming) {
        return;
      }

      setSelectedGhostName(name);
      setStatusMessage(null);
    },
    [isStreaming]
  );

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (!selectedGhostName || isStreaming) {
        return;
      }

      try {
        await apiClient.switchSession(selectedGhostName, sessionId);
        setStatusMessage("Switched session.");
        await refreshSelectedGhost();
      } catch (error) {
        setStatusMessage(toNotice(error));
      }
    },
    [isStreaming, refreshSelectedGhost, selectedGhostName]
  );

  const handleSpawn = useCallback(() => {
    setStatusMessage("Spawn a ghost from the CLI or API first.");
  }, []);

  const currentSessionLabel = currentSession ? currentSession.name?.trim() || currentSession.id.slice(0, 12) : null;

  return (
    <Box flexDirection="column" height="100%">
      <Box paddingX={1}>
        <Text bold>GHOSTBOX</Text>
      </Box>
      <Box flexGrow={1}>
        {sidebarVisible ? (
          <Sidebar
            ghosts={ghosts}
            selectedGhostName={selectedGhostName}
            sessions={sessions}
            sessionsError={sessionsError}
            sessionsLoading={sessionsLoading}
            isFocused={focus === "sidebar"}
            isStreaming={isStreaming}
            onSelectGhost={handleSelectGhost}
            onSwitchSession={handleSwitchSession}
            onSpawn={handleSpawn}
          />
        ) : null}
        <ChatPane
          ghost={selectedGhost}
          currentSessionLabel={currentSessionLabel}
          messages={messages}
          stats={stats}
          isFocused={focus === "chat"}
          isStreaming={isStreaming}
          isLoading={isLoading}
          error={detailError}
          onSubmit={handleSubmit}
        />
      </Box>
      <StatusBar
        model={stats?.model ?? selectedGhost?.ghost.model ?? null}
        stats={stats}
        streaming={isStreaming}
        message={statusMessage}
      />
    </Box>
  );
};
