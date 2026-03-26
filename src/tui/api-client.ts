import type { GhostMessage, GhostState, GhostStats, HistoryResponse, SessionListResponse } from "../types";

const API_BASE_URL = process.env.GHOSTBOX_API_URL?.trim() || "http://localhost:8008";

type ApiErrorPayload = {
  error?: unknown;
};

type SseEvent = {
  event: string;
  data: string;
};

const buildUrl = (path: string): string => {
  return `${API_BASE_URL}${path}`;
};

const toError = async (response: Response): Promise<Error> => {
  let message = `Request failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as ApiErrorPayload;
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      message = payload.error;
    }
  } catch {
    const text = await response.text().catch(() => "");
    if (text.trim().length > 0) {
      message = text.trim();
    }
  }

  return new Error(message);
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(buildUrl(path), init);
  if (!response.ok) {
    throw await toError(response);
  }

  return (await response.json()) as T;
};

const parseSseEvent = (chunk: string): SseEvent | null => {
  const lines = chunk
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    event,
    data: dataLines.join("\n")
  };
};

export const apiClient = {
  listGhosts(): Promise<Record<string, GhostState>> {
    return request<Record<string, GhostState>>("/api/ghosts");
  },

  getHistory(name: string): Promise<HistoryResponse> {
    return request<HistoryResponse>(`/api/ghosts/${encodeURIComponent(name)}/history`);
  },

  getSessions(name: string): Promise<SessionListResponse> {
    return request<SessionListResponse>(`/api/ghosts/${encodeURIComponent(name)}/sessions`);
  },

  getStats(name: string): Promise<GhostStats> {
    return request<GhostStats>(`/api/ghosts/${encodeURIComponent(name)}/stats`);
  },

  async newSession(name: string): Promise<{ status: "new_session"; sessionId: string }> {
    return await request<{ status: "new_session"; sessionId: string }>(`/api/ghosts/${encodeURIComponent(name)}/new`, {
      method: "POST"
    });
  },

  async switchSession(name: string, sessionId: string): Promise<{ status: "switched"; sessionId: string }> {
    return await request<{ status: "switched"; sessionId: string }>(
      `/api/ghosts/${encodeURIComponent(name)}/sessions/switch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      }
    );
  },

  async *streamMessage(
    name: string,
    prompt: string,
    options?: { model?: string; signal?: AbortSignal }
  ): AsyncGenerator<GhostMessage> {
    const response = await fetch(buildUrl(`/api/ghosts/${encodeURIComponent(name)}/message`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {})
      }),
      signal: options?.signal
    });

    if (!response.ok) {
      throw await toError(response);
    }

    if (!response.body) {
      throw new Error("Streaming response body was empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(rawEvent);

        if (!event) {
          continue;
        }

        if (event.event === "done") {
          return;
        }

        if (event.event === "error") {
          let message = "Streaming request failed.";
          if (event.data.length > 0) {
            try {
              const payload = JSON.parse(event.data) as ApiErrorPayload;
              if (typeof payload.error === "string" && payload.error.trim().length > 0) {
                message = payload.error;
              }
            } catch {
              message = event.data;
            }
          }

          throw new Error(message);
        }

        if (event.data.length === 0) {
          continue;
        }

        yield JSON.parse(event.data) as GhostMessage;
      }
    }
  }
};
