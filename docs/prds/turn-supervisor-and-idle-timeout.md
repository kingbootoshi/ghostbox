# Turn Supervisor + Idle Timeout

## Problem

GREED's 2026-05-03 incident exposed a structural flaw in `docker/ghost-server-claude.ts`: the ghost-server treats subprocess exit as the only signal a turn is done. When a bash tool call hangs forever (GREED wrote a malformed `until [ -f a b ]` polling loop that sleeps forever), Claude blocks waiting for the tool result and never emits `result`. The container's `activeTurn` stayed pinned with `finished=false`. Subsequent user messages were queued into `queue.messages` and orphaned — the queue only drains when the next user POST arrives, so they sit in memory waiting for a future caller. The scheduler's `dispatchScheduledPrompt` was still awaiting the response stream and silently lied about completion. Full forensic + design rationale: `~/Dev/agent-runtime-kernel/docs/learnings/2026-05-03-stuck-turn.md`.

## Solution

Replace the event-driven `activeTurn` + followUp queue model in `docker/ghost-server-claude.ts` with a single **turn supervisor** that owns lifecycle. The supervisor enforces a per-turn idle deadline (8 min) and wall-clock deadline (25 min) independent of the model. Background output (auto-drains, scheduled prompts) routes through a typed `Sink` so timeline + jsonl persistence runs regardless of caller. Cap Bash tool call duration at the agent layer via Claude Code env vars. Schedulers must see a distinct "completed" vs "queued" signal so `lastFired` cannot advance on a queued message.

This is a one-shot replacement, not an additive patch. The existing `if (activeTurn === turn)` defensive guards, `sessionOpLock`, and force-clear branch get deleted — the supervisor model makes them unnecessary.

## Requirements

- Single turn supervisor in `ghost-server-claude.ts` owns the worklist; nothing else mutates "is a turn running."
- Turn idle timeout: 8 min default, env-overridable as `GHOSTBOX_TURN_IDLE_TIMEOUT_MS`. Reset on every stdout chunk.
- Turn wall-clock timeout: 25 min default, env-overridable as `GHOSTBOX_TURN_WALL_TIMEOUT_MS`. Set at turn start, never reset.
- Container deadlines must be strictly less than the host's `DEFAULT_GHOST_MESSAGE_TIMEOUT_MS` (30 min) so container kills first and host receives a clean synthetic `result` line.
- Timeout escalation: SIGTERM → 5s grace → SIGKILL.
- Synthesized `result` line on timeout includes a clear marker text: `"Turn killed: idle 8m"` or `"Turn killed: wall-clock 25m"`. Not silent.
- `Sink` interface with three implementations: `HttpStreamSink`, `EventSink`, `NullSink`. Background turns (auto-drains) use `EventSink` so the host can deliver to Telegram/native unsolicited.
- Auto-drain: when supervisor finishes one item and the worklist has more, it pulls the next automatically — no external trigger required.
- `handleMessage` enqueues with `deliverTo = res` and the supervisor either runs the turn immediately or rejects with HTTP 409 if a turn is already running for a different originator. No more "Queued for next turn." 200 response that silently parks the message.
- Wait — Saint's actual UX expectation needs preserving: in the native app, typing a follow-up while the agent is responding *should* queue. The fix: queue still happens, but as supervisor work items with explicit `deliverTo: EventSink` so the native app sees the response asynchronously through the realtime channel. The HTTP response to the second POST returns 202 with a queued-job-id, not 200 with fake "result".
- `dispatchScheduledPrompt` only advances `lastFired` after the supervisor confirms the turn produced a real `result` (clean or synthesized-timeout). If the work item was rejected (sandbox down, etc.) the scheduler retries on next tick, no advance.
- `handleSteer` gates on `child.exitCode === null && child.stdin.writable` and routes through the supervisor's `steer(text)` method. No raw stdin writes from request handlers.
- Container Dockerfile sets `ENV CLAUDE_CODE_BASH_DEFAULT_TIMEOUT_MS=300000` (5 min default) and `ENV BASH_MAX_TIMEOUT_MS=480000` (8 min hard cap) so the model cannot override past 8 minutes. This is the root-cause defense — addresses the GREED incident at the agent layer before supervisor defenses kick in.
- Wide-event telemetry: every turn emits one log entry at completion with `turn_id`, `session_id`, `agent_name`, `originator`, `duration_ms`, `outcome` (`result` | `idle_timeout` | `wallclock_timeout` | `subprocess_error`), `last_stdout_at`, `bytes_streamed`, `queue_depth_at_start`.

## Implementation Plan

### Phase 1: Bash tool timeout cap (cheap, ship first)

- [ ] Add `ENV CLAUDE_CODE_BASH_DEFAULT_TIMEOUT_MS=300000` and `ENV BASH_MAX_TIMEOUT_MS=480000` to `docker/Dockerfile`.
- [ ] Bump image version (the `gb-` tag in `~/.ghostbox/state.json` config).
- [ ] Verify in container: `docker exec ghostbox-<name> env | grep TIMEOUT`.
- [ ] Add a comment in Dockerfile pointing at `~/Dev/agent-runtime-kernel/docs/learnings/2026-05-03-stuck-turn.md` for the rationale.

### Phase 2: Turn supervisor

- [ ] New file: `docker/turn-supervisor.ts`. Exports `class TurnSupervisor` with `enqueue(item)`, `currentTurn()`, `steer(text)`, `abort()`, `start()`, `stop()`. Pure logic, no HTTP. (file: `docker/turn-supervisor.ts`, ~250-280 lines)
- [ ] New file: `docker/sinks.ts`. Exports `interface Sink { sendLine(line); end(); }`, plus `HttpStreamSink`, `EventSink`, `NullSink`. (~80-120 lines)
- [ ] New file: `docker/turn-runner.ts`. Exports `runClaudeTurn(messages, sink, opts)` — the core that spawns claude, drives stdin, parses stdout, attaches idle + wall-clock timers, persists snapshots, calls `handleClaudeStreamLine`. Replaces `spawnClaudeMessage` body. (~300-350 lines max; split if it grows)
- [ ] Refactor `ghost-server-claude.ts`:
  - Delete `activeTurn` global, `sessionOpLock`, `clearActiveTurn`, the result-event SIGTERM branch (it's now in `runClaudeTurn`), the force-clear branch in `handleMessage`, the `if (activeTurn === turn)` guards.
  - Replace with a module-scoped `TurnSupervisor` instance.
  - `handleMessage` becomes: parse body → `supervisor.enqueue({ userTurn, deliverTo: HttpStreamSink(res), originator: "user" })` → either streams the live turn or returns 202 with queue position.
  - `handleSteer` becomes: `supervisor.steer(prompt)`.
  - `handleAbort` becomes: `supervisor.abort()`.
  - `handleQueue` reads `supervisor.queueSnapshot()`.
  - `handleClearQueue` calls `supervisor.clearQueue()`.

### Phase 3: Schedule manager + host alignment

- [ ] `src/schedule-manager.ts`: `dispatchScheduledPrompt` interprets a sentinel `{ type: "queued", queueJobId }` from the host stream as "not completed; do not advance." Rethrow as `ScheduleQueuedError` that `processDueSchedules` catches and treats as "retry next tick, do not advance lastFired."
- [ ] `src/orchestrator.ts`: `sendMessage` yields a typed message envelope that downstream callers (schedule-manager, telegram bot, native HTTP) can distinguish: `result` vs `queued` vs `aborted`. Scheduler watches for `result`, native UI displays whichever.

### Phase 4: Telemetry

- [ ] Wide event logging at supervisor turn completion. One entry per turn, structured. No scattered console.log replacements — exists in one place (the supervisor) and is enriched as the turn progresses.
- [ ] Rename or augment the existing `Killing ghost`, `Vault operation` log lines so they all carry `turn_id` for correlation.

## File Structure

```
docker/
  ghost-server-claude.ts          # HTTP routing, glue. Heavily slimmed.
  turn-supervisor.ts              # NEW. Owns lifecycle.
  turn-runner.ts                  # NEW. Spawns claude, parses stream, enforces timeouts.
  sinks.ts                        # NEW. Sink interface + 3 impls.
  ghost-server-claude-types.ts    # (existing types) - extract if too large
  Dockerfile                      # +2 ENV lines
src/
  orchestrator.ts                 # sendMessage envelope changes
  schedule-manager.ts             # ScheduleQueuedError handling
docs/
  prds/turn-supervisor-and-idle-timeout.md  # this file
```

Constraints: no file over ~350 lines. If `turn-runner.ts` exceeds, extract `claude-stream-parser.ts` for the line-by-line parsing.

## Testing

- [ ] Unit test in `tests/`: fake claude binary (shell script writing partial stream-json then sleeping forever). Spawn supervisor with `GHOSTBOX_TURN_IDLE_TIMEOUT_MS=2000`. Assert idle timeout fires at 2s, child SIGTERMed, synthetic `result` emitted with `Turn killed: idle 2s`, supervisor moves to next item.
- [ ] Unit test: same fake claude, fake immediate result, queue 3 items, assert all 3 process in order without external POST triggering.
- [ ] Race test: 1000 iterations of "POST /message at the exact moment turn close handler runs." Assert: either new turn owns next slot, or close-handler drains queue. Never both, never neither.
- [ ] Bash-timeout regression test: in-container fixture that asks claude to run `until [ -f /tmp/never ]; do sleep 2; done`. With Bash cap, the tool call returns timeout-error within 5 min, claude continues. Without the env vars (regression), supervisor's idle timeout cuts at 8 min. Either way, turn ends.
- [ ] Schedule-manager test: stub `sendMessage` to yield a `queued` envelope. Assert `dispatchScheduledPrompt` throws `ScheduleQueuedError` and `lastFired` does not advance.
- [ ] E2E on `mini`: deploy, kick a real GREED turn, send a follow-up, observe queue draining via Sink/EventSink end-to-end. Verify telemetry log entries.

## Success Criteria

- A bash polling loop with the exact GREED bug cannot stall a turn longer than 8 minutes (Bash cap) or 25 minutes (wall-clock).
- A queued user message is delivered to the user without requiring a second user POST.
- A scheduled prompt that hits a busy supervisor does not silently advance `lastFired`.
- The current production behavior of the May 3 commit set (timeout abort, force-clear stale activeTurn) becomes obsolete and is deleted, not stacked.
- All existing passing tests still pass.
- New tests cover the timeout, drain, and scheduler-retry paths.
- One wide event per turn lands in `~/.ghostbox/server.log` in the host and the container ghost-server log.

## Out of scope

- Multi-worker concurrency per agent.
- Persisted queue (memory-only is fine; restart drains via supervisor stop hook).
- Migration of agent-level system prompt updates ("write better bash" nudges) — handled separately.
- Bash AST linter — Phase 1 + Phase 2 cover the failure mode structurally.
- Bringing the supervisor design into `agent-runtime-kernel` — captured in `docs/learnings/2026-05-03-stuck-turn.md`, will inform the kernel's runner contract design directly. No code work in this PRD.
