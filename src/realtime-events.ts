import type { GhostState, RealtimeEvent } from "./types";

type QueuedEvent = Exclude<RealtimeEvent, { type: "snapshot" }>;
type SubscriptionSeed =
  | { kind: "snapshot"; event: RealtimeEvent & { type: "snapshot" } }
  | { kind: "replay"; events: QueuedEvent[] };

type Listener = (event: QueuedEvent) => void;

const MAX_BUFFERED_EVENTS = 500;

let nextEventId = 1;
const eventBuffer: QueuedEvent[] = [];
const listeners = new Set<Listener>();

const nextId = (): string => {
  const id = String(nextEventId);
  nextEventId += 1;
  return id;
};

const currentId = (): string => String(Math.max(0, nextEventId - 1));

const parseEventId = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const buildSnapshotEvent = (ghosts: Record<string, GhostState>): RealtimeEvent & { type: "snapshot" } => ({
  id: currentId(),
  at: new Date().toISOString(),
  type: "snapshot",
  ghosts
});

const queueEvent = (event: QueuedEvent): void => {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFERED_EVENTS) {
    eventBuffer.shift();
  }

  for (const listener of listeners) {
    listener(event);
  }
};

export const publishGhostUpsertEvent = (ghostName: string, ghost: GhostState): QueuedEvent => {
  const event: QueuedEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type: "ghost.upsert",
    ghostName,
    ghost
  };
  queueEvent(event);
  return event;
};

export const publishGhostRemoveEvent = (ghostName: string): QueuedEvent => {
  const event: QueuedEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type: "ghost.remove",
    ghostName
  };
  queueEvent(event);
  return event;
};

export const publishMessageCompletedEvent = (ghostName: string, sessionId: string, preview: string): QueuedEvent => {
  const event: QueuedEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type: "message.completed",
    ghostName,
    sessionId,
    preview
  };
  queueEvent(event);
  return event;
};

export const publishGhostTurnMessageEvent = (
  ghostName: string,
  event: Omit<Extract<RealtimeEvent, { type: "ghost.turn-message" }>, "id" | "at" | "type" | "ghostName">
): QueuedEvent => {
  const queuedEvent: QueuedEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type: "ghost.turn-message",
    ghostName,
    ...event
  };
  queueEvent(queuedEvent);
  return queuedEvent;
};

export const publishGhostTurnCompleteEvent = (
  ghostName: string,
  event: Omit<Extract<RealtimeEvent, { type: "ghost.turn-complete" }>, "id" | "at" | "type" | "ghostName">
): QueuedEvent => {
  const queuedEvent: QueuedEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type: "ghost.turn-complete",
    ghostName,
    ...event
  };
  queueEvent(queuedEvent);
  return queuedEvent;
};

export const createRealtimeSubscription = (
  ghosts: Record<string, GhostState>,
  afterId: string | null | undefined
): {
  seed: SubscriptionSeed;
  next: (timeoutMs?: number) => Promise<QueuedEvent | null>;
  close: () => void;
} => {
  const numericAfterId = parseEventId(afterId);
  const oldestId = eventBuffer.length > 0 ? parseEventId(eventBuffer[0].id) : null;

  const needsSnapshot = numericAfterId === null || (oldestId !== null && numericAfterId < oldestId - 1);

  const queued = needsSnapshot
    ? []
    : eventBuffer.filter((event) => (parseEventId(event.id) ?? 0) > (numericAfterId ?? 0));

  let resolver: ((event: QueuedEvent | null) => void) | null = null;

  const listener: Listener = (event) => {
    if (resolver) {
      const activeResolver = resolver;
      resolver = null;
      activeResolver(event);
      return;
    }

    queued.push(event);
  };

  listeners.add(listener);

  const next = (timeoutMs = 0): Promise<QueuedEvent | null> => {
    if (queued.length > 0) {
      return Promise.resolve(queued.shift() ?? null);
    }

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      resolver = (event) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(event);
      };

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (resolver) {
            resolver = null;
          }
          resolve(null);
        }, timeoutMs);
        timeoutId.unref?.();
      }
    });
  };

  const close = (): void => {
    listeners.delete(listener);
    if (resolver) {
      const activeResolver = resolver;
      resolver = null;
      activeResolver(null);
    }
  };

  return {
    seed: needsSnapshot
      ? { kind: "snapshot", event: buildSnapshotEvent(ghosts) }
      : { kind: "replay", events: queued.splice(0) },
    next,
    close
  };
};

export const __resetRealtimeEventsForTests = (): void => {
  nextEventId = 1;
  eventBuffer.length = 0;
  listeners.clear();
};
