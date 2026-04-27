import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetRealtimeEventsForTests,
  createRealtimeSubscription,
  publishGhostUpsertEvent,
  publishMessageCompletedEvent
} from "../../src/realtime-events";
import { createGhostState } from "../support/test-state";

afterEach(() => {
  __resetRealtimeEventsForTests();
});

describe("realtime event subscriptions", () => {
  test("seeds with a snapshot when there is no replay cursor", () => {
    const alpha = createGhostState({ name: "alpha" });
    const beta = createGhostState({ name: "beta", status: "stopped" });
    const subscription = createRealtimeSubscription({ alpha, beta }, null);

    expect(subscription.seed.kind).toBe("snapshot");
    if (subscription.seed.kind === "snapshot") {
      expect(subscription.seed.event.type).toBe("snapshot");
      expect(subscription.seed.event.ghosts).toEqual({ alpha, beta });
    }

    subscription.close();
  });

  test("replays buffered events after the provided cursor", () => {
    const alpha = createGhostState({ name: "alpha" });
    const first = publishGhostUpsertEvent("alpha", alpha);
    const second = publishMessageCompletedEvent("alpha", "session-1", "done");

    const subscription = createRealtimeSubscription({}, first.id);

    expect(subscription.seed.kind).toBe("replay");
    if (subscription.seed.kind === "replay") {
      expect(subscription.seed.events).toEqual([second]);
    }

    subscription.close();
  });

  test("delivers new events to active subscribers", async () => {
    const alpha = createGhostState({ name: "alpha" });
    const subscription = createRealtimeSubscription({}, "0");
    const nextEvent = subscription.next(100);

    const published = publishGhostUpsertEvent("alpha", alpha);
    await expect(nextEvent).resolves.toEqual(published);

    subscription.close();
  });
});
