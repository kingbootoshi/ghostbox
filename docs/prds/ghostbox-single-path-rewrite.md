# Master PRD: Ghostbox Single-Path Rewrite

## Mandate

Rewrite Ghostbox around one consistent logic path per domain.

The merged system must not rely on:
- dual API contracts
- client-side truth fallbacks
- fake-success compatibility shims
- duplicated connection state
- hidden runtime guessing
- adapter-specific behavior leaking into clients

This is not a bug-fix pass. It is an architecture consolidation.

## Why This Exists

The current system still carries layered compatibility code from several past eras:
- old full-history plus new paged-history
- Pi adapter and Claude adapter implementing the same contract separately
- native chat scroll-follow controlled by multiple overlapping heuristics
- native model state and slash commands partially owned by the client
- connection state split across CLI config, native defaults, and token files
- upgrade/version tracking that trusts host-side state more than runtime-reported reality

These are not isolated paper cuts. They are all manifestations of the same problem:

Ghostbox still has multiple competing sources of truth.

## Hard Invariants

These rules define “done”.

1. Every domain has exactly one source of truth.
2. Every network contract has exactly one production shape.
3. Unsupported operations are explicit, never silent, never fake-success.
4. Client UI state must only reflect acknowledged server state for persisted settings.
5. Runtime version and capability data must be reported by the running adapter, not inferred from host state alone.
6. Continuous chat history must be backed by one timeline model end to end.
7. Any migration code must be explicit and temporary, not a permanent runtime fallback.

## Architecture Target

### 1. Canonical Connection State

#### Current problems
- CLI stores remote config in [src/remote-config.ts](/Users/saint/Dev/ghostbox/src/remote-config.ts:35).
- Native reads `serverURL` from `UserDefaults` in [GhostboxClient.swift](/Users/saint/Dev/ghostbox/native/Sources/Services/GhostboxClient.swift:205).
- Native token storage uses `~/.ghostbox/app-token` via [KeychainHelper.swift](/Users/saint/Dev/ghostbox/native/Sources/Services/KeychainHelper.swift:16).
- `remote.json` is currently weaker than the other credential files and is echoed by CLI status.

#### Target
- Introduce one canonical client connection file: `~/.ghostbox/connection.json`.
- Store both URL and token there with `0600` permissions.
- CLI, native app, and TUI all read and write the same file.
- Localhost is not a hidden fallback. `init` writes the initial local connection explicitly.
- `remote.json`, `UserDefaults.serverURL`, and `app-token` are deleted from steady-state runtime ownership.

#### Required behavior
- Connection status and settings screens reflect the canonical file.
- CLI status redacts the token.
- Missing or invalid connection config is surfaced as an error, not guessed around.

### 2. Canonical Runtime Meta Contract

#### Current problems
- Adapters expose behavior implicitly.
- Claude still returns success-like responses for unsupported operations such as `/reload`.
- Host upgrade logic trusts stored `imageVersion` more than the live container.

#### Target
- Every adapter must expose one runtime meta endpoint, for example `GET /runtime`.
- Response includes:
  - `adapter`
  - `buildHash`
  - `capabilities`
  - `commands`
  - `model`
  - `sessionId`
- Host proxies this as `GET /api/ghosts/:name/runtime`.
- Native, web, TUI, and CLI use this to decide which actions to show.

#### Required behavior
- If a capability is unsupported, the host and clients disable it before invocation.
- If a call still reaches an unsupported operation, the adapter returns `501` or a clear `409`, never `200`.
- Upgrade verification compares desired host build hash against adapter-reported `buildHash`.

### 3. Canonical Timeline Contract

#### Current problems
- `/history` still has dual shape behavior.
- Pre-compaction and post-compaction history are split into separate paths.
- Native `ConversationStore` still carries separate shadow state for pre-compaction history.

#### Target
- Replace dual history shapes with one canonical timeline contract.
- Preferred route: `GET /api/ghosts/:name/timeline?cursor=<opaque>&limit=<n>`.
- Response shape:
  - `items`
  - `nextCursor`
  - `hasMore`
  - `totalCount`
- `items` are typed timeline entries:
  - `message`
  - `compaction_marker`
  - optionally `session_marker` if needed later

#### Required behavior
- No `segment=pre|post`.
- No legacy full-history response.
- No explicit “load older messages” UI.
- Adapters share one normalization module for timeline shaping and pagination semantics.

#### Client consequences
- Native chat renders one continuous timeline.
- Compaction becomes just another timeline item.
- Older history is auto-fetched near the top and inserted into the same list.

### 4. Canonical Command and Settings Ownership

#### Current problems
- Native slash commands start from a hardcoded fallback list in [SlashCommandPopup.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/SlashCommandPopup.swift:55).
- Model switching in native fabricates local success state in [AgentChatViewModel.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/AgentChatViewModel.swift:226).

#### Target
- Commands are fully server-owned and returned via runtime meta.
- Persisted settings changes use explicit API routes and server acknowledgements.
- Slash command execution and UI controls both route through the same server-owned capability and command layer.

#### Required behavior
- Native does not invent fallback slash commands.
- Native does not locally mutate persistent model state when the server call fails.
- Chat header, hub, and runtime meta remain consistent.

### 5. Canonical Scroll Model

#### Current problems
- Chat follow-latest is re-armed by multiple overlapping code paths in [AgentChatView.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/AgentChatView.swift:334).
- Streaming, finalization, and session-change events can all fight user scroll intent.

#### Target
- Replace heuristic overlap with one explicit scroll coordinator and one state machine.
- Use AppKit-backed scroll observation for the supported deployment target instead of relying on mixed SwiftUI-only behavior.
- State machine:
  - `followingLatest`
  - `detachedByUser`
  - `programmaticJump`

#### Required behavior
- User scroll upward immediately detaches follow-latest.
- Streaming continues without changing user position.
- Finalization does not restyle or re-anchor the message block.
- “Jump to latest” is the only explicit way back to auto-follow.

### 6. Canonical Local Runtime Behavior

#### Current problems
- Native app can auto-start the host by guessing repo roots in [AppDelegate.swift](/Users/saint/Dev/ghostbox/native/Sources/App/AppDelegate.swift:155).
- CLI “already running” detection probes `/api/config` instead of `/api/health` in [src/cli.ts](/Users/saint/Dev/ghostbox/src/cli.ts:695).
- `init` saves `imageName` then ignores it when building in [src/cli.ts](/Users/saint/Dev/ghostbox/src/cli.ts:933) and [src/cli.ts](/Users/saint/Dev/ghostbox/src/cli.ts:951).

#### Target
- Local runtime behavior is explicit.
- `ghostbox serve` probes `/api/health`.
- Native auto-launch is either:
  - clearly marked dev-only behavior, or
  - removed from production runtime behavior entirely.
- `init` honors configured `imageName`.
- State/config corruption is surfaced, not swallowed by broad `catch` blocks.

## Delete List

These should not survive the merged rewrite:
- dual-shape `/history`
- `segment=pre|post`
- native `fallbackGhost` on model switch
- hardcoded slash command fallback ownership
- dead hub polling fallback
- fake-success Claude compatibility endpoints
- duplicate connection state across `remote.json`, native defaults, and `app-token`

## Temporary Migration Rule

Branch-local migration code is allowed while the rewrite is in progress.

Merged-state rule:
- No steady-state dual paths.
- No permanent runtime fallback that silently preserves old behavior.
- If a migration is required for existing installs, it must be:
  - explicit
  - one-shot
  - observable
  - removable in the next cleanup release

## Parallel Workstreams

This is the execution plan I would use as main orchestrator.

### Track A: Contracts and Shared Runtime Semantics

**Owner**
- Main contract worker

**Scope**
- [src/types.ts](/Users/saint/Dev/ghostbox/src/types.ts)
- [src/api.ts](/Users/saint/Dev/ghostbox/src/api.ts)
- [src/orchestrator.ts](/Users/saint/Dev/ghostbox/src/orchestrator.ts)
- [src/ghost-handlers.ts](/Users/saint/Dev/ghostbox/src/ghost-handlers.ts)
- [src/ghost-server.ts](/Users/saint/Dev/ghostbox/src/ghost-server.ts)
- [docker/ghost-server-claude.ts](/Users/saint/Dev/ghostbox/docker/ghost-server-claude.ts)

**Deliverables**
- shared runtime meta contract
- shared canonical timeline contract
- shared pagination/cursor logic
- removal of fake-success unsupported operations

**Dependencies**
- none, this freezes the architecture for the other tracks

### Track B: Connection and Config Unification

**Owner**
- client/runtime config worker

**Scope**
- [src/remote-config.ts](/Users/saint/Dev/ghostbox/src/remote-config.ts)
- [src/cli.ts](/Users/saint/Dev/ghostbox/src/cli.ts)
- [native/Sources/Services/GhostboxClient.swift](/Users/saint/Dev/ghostbox/native/Sources/Services/GhostboxClient.swift)
- [native/Sources/App/AppDelegate.swift](/Users/saint/Dev/ghostbox/native/Sources/App/AppDelegate.swift)
- [native/Sources/App/ConnectionView.swift](/Users/saint/Dev/ghostbox/native/Sources/App/ConnectionView.swift)
- [native/Sources/Hub/HubSettingsView.swift](/Users/saint/Dev/ghostbox/native/Sources/Hub/HubSettingsView.swift)
- [native/Sources/Services/KeychainHelper.swift](/Users/saint/Dev/ghostbox/native/Sources/Services/KeychainHelper.swift)

**Deliverables**
- canonical `connection.json`
- token redaction in CLI status
- `0600` permission hardening
- `/api/health` runtime detection
- removal of duplicate connection ownership

**Dependencies**
- Track A only for any runtime meta references

### Track C: Native Timeline Store and Scroll Rewrite

**Owner**
- native state worker

**Scope**
- [native/Sources/Chat/ConversationStore.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/ConversationStore.swift)
- [native/Sources/Chat/AgentChatView.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/AgentChatView.swift)
- [native/Sources/Chat/ChatDisplayItem.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/ChatDisplayItem.swift)
- [native/Sources/Chat/AgentChatViewModel.swift](/Users/saint/Dev/ghostbox/native/Sources/Chat/AgentChatViewModel.swift)

**Deliverables**
- one timeline item array
- cursor-based top prefetch
- explicit scroll coordinator
- removal of pre-compaction shadow state
- removal of native model-switch fallback state

**Dependencies**
- Track A timeline contract frozen first

### Track D: Commands, Capabilities, and UI Gating

**Owner**
- command/capability worker

**Scope**
- adapter runtime meta command reporting
- native command UI
- hub/chat capability gating

**Deliverables**
- no hardcoded slash command fallback ownership
- capability-aware controls
- explicit unsupported behavior

**Dependencies**
- Track A runtime meta frozen first

### Track E: Upgrade and Version Truth

**Owner**
- runtime/deploy worker

**Scope**
- [src/orchestrator.ts](/Users/saint/Dev/ghostbox/src/orchestrator.ts)
- upgrade docs
- adapter runtime build hash reporting

**Deliverables**
- runtime-reported build hash
- upgrade verification against live containers
- `imageName` honored during `init`
- docs aligned to actual build hash inputs

**Dependencies**
- Track A runtime meta frozen first

### Track F: Delete Dead Compatibility Code

**Owner**
- cleanup worker

**Scope**
- dead polling
- obsolete migration helpers
- unused compatibility branches
- misleading no-op descriptions

**Deliverables**
- dead code deletion only after Tracks A-E land

**Dependencies**
- all functional tracks complete first

## Review Plan

Every track gets its own reviewer, independent from the implementer.

### Review 1: Contract Review
- Validate one contract shape only
- Validate adapter parity
- Validate unsupported ops return explicit failure

### Review 2: Native State Review
- Validate one timeline model
- Validate no local persistent-state fabrication
- Validate scroll state machine ownership

### Review 3: Runtime/Deploy Review
- Validate connection source unification
- Validate version handshake
- Validate no hidden config drift

## Verification Matrix

### Automated
- `bun run typecheck`
- `bun test`
- contract tests for timeline endpoint on both adapters
- contract tests for runtime meta endpoint on both adapters
- tests for connection file permissions and redaction
- tests for `ghostbox serve` detecting `/api/health`

### Native Build
- `xcodebuild -project native/Ghostbox.xcodeproj -scheme Ghostbox -configuration Debug build`

### Manual
- Localhost connect flow
- Remote connect flow
- Open long GREED-style chat and scroll upward during streaming
- Verify no forced bottom-lock while streaming
- Verify final message does not snap or restyle on completion
- Verify older history auto-loads into the same thread surface
- Verify unsupported adapter actions are hidden or return explicit unsupported

### Runtime
- `ghostbox upgrade` on local host
- remote upgrade on deployed host
- verify host-reported desired build hash matches adapter runtime build hash

## Phase Gates

### Phase 0: Architecture Freeze
- Contracts for `connection`, `runtime meta`, and `timeline` are written and approved.
- No implementation starts before these shapes are frozen.

### Phase 1: Backend Contract Rewrite
- Tracks A and E land together or in dependency-safe order.
- No merged code may preserve dual history contracts.

### Phase 2: Client Ownership Rewrite
- Tracks B, C, and D land against the frozen backend contracts.

### Phase 3: Compatibility Deletion
- Track F deletes dead fallback code.
- Final merged branch has one path only.

## Out of Scope

These are not part of this rewrite unless required by the single-path architecture:
- visual redesign
- new product surfaces
- unrelated Telegram feature work
- new scheduling semantics
- major adapter feature additions beyond capability correctness

## Success Criteria

Ghostbox is done when all of these are true:

1. There is one canonical connection config path.
2. There is one canonical runtime meta contract.
3. There is one canonical timeline contract.
4. The native app renders one continuous history model.
5. Streaming never forcibly reclaims user scroll.
6. Unsupported operations are explicit and capability-gated.
7. Upgrade correctness is verified against the running adapter, not guessed.
8. The merged branch contains no steady-state fallback or dual-path logic for these domains.

## Research Notes

Relevant external references used while shaping this PRD:
- [Apple `ScrollPosition`](https://developer.apple.com/documentation/SwiftUI/ScrollPosition)
- [Apple `NSScrollView.didLiveScrollNotification`](https://developer.apple.com/documentation/appkit/nsscrollview/didlivescrollnotification)
- [Apple `NSView.boundsDidChangeNotification`](https://developer.apple.com/documentation/appkit/nsviewboundsdidchangenotification)
- [RFC 9110 - HTTP Semantics](https://www.rfc-editor.org/in-notes/rfc9110.pdf)

