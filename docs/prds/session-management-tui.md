# Session Management + TUI + Native App Fixes

## Problem

1. Ghosts have one long-running conversation that compacts forever. No way to start a new session, browse old sessions, or switch between them.
2. Clicking a stopped ghost in the native app errors instead of auto-waking it.
3. No message input history (double-escape to cycle back through sent messages).
4. No terminal UI - only web and native clients exist.
5. All three clients (native, web, TUI) need to stay in sync via the same API.

## Solution

Three parallel workstreams that all build on the same API server.

---

## Phase 1: Backend - Session Management + Auto-Wake

### 1A: Session List Endpoint

Add `GET /sessions` to ghost-server.ts (inside container).

Pi SDK already persists sessions as JSONL files at `/root/.pi/agent/sessions/--vault--/*.jsonl`. Use `SessionManager.list('/vault')` to enumerate them.

```
GET /api/ghosts/:name/sessions
Response: {
  current: string,          // current session ID
  sessions: [{
    id: string,
    name: string | null,    // from appendSessionInfo
    path: string,
    messageCount: number,
    createdAt: string,
    lastActiveAt: string
  }]
}
```

Proxy through orchestrator like other ghost endpoints.

### 1B: Session Switch Endpoint

Add `POST /sessions/switch` to ghost-server.ts.

Uses `SessionManager.open(path)` to switch to a specific session file, then recreates the AgentSession with that session manager.

```
POST /api/ghosts/:name/sessions/switch
Body: { sessionId: string }
Response: { status: "switched", sessionId: string }
```

This requires:
- Finding the session file by ID from the list
- Creating a new SessionManager from that file
- Recreating the AgentSession with the new session manager
- Updating the module-level session/sessionManager references

### 1C: Fix /new Response

`POST /api/ghosts/:name/new` currently drops the sessionId. The inner ghost-server returns it - just pass it through in the orchestrator proxy.

### 1D: Auto-Wake on Message

In `POST /api/ghosts/:name/message` (src/api.ts), if ghost is stopped:
1. Call `wakeGhost(name)` first
2. Wait for health check
3. Then send the message

This means any client can just send a message to a stopped ghost and it wakes up automatically.

### 1E: SSE Event Bus (sync across clients)

Add `GET /api/events` SSE endpoint to api.ts. Broadcasts:
- `ghost:spawned`, `ghost:killed`, `ghost:woke`, `ghost:removed`
- `session:new`, `session:switched`

All clients subscribe. When any client changes state, others see it instantly.

---

## Phase 2: Native macOS App Fixes

### 2A: Auto-Wake on Ghost Click

In `openChat(ghostName:)` or `AgentChatViewModel.init`:
- Check ghost status from the ghost list
- If stopped, show "Waking ghost..." indicator
- Call `POST /api/ghosts/:name/wake` first
- Then load history and enable input

Alternative: rely on Phase 1D backend auto-wake. Client just sends message, backend handles wake. But the row click should still open chat immediately with a "Waking..." state.

### 2B: Double-Escape Message History

Add sent message history ring to `AgentChatViewModel`:
- `sentHistory: [String]` - stores last N sent messages
- `historyIndex: Int?` - current position in history, nil when not browsing
- First Escape: if streaming, cancel stream (existing behavior)
- Second Escape (within 500ms): enter history mode
  - Up arrow: move back through sentHistory, replace input text
  - Down arrow: move forward, or clear to return to current
  - Escape again or Return: exit history mode
- Store the current draft before entering history mode, restore on exit

### 2C: Better Server Startup Messaging

In `AppDelegate.ensureServerRunning()`:
- If health check fails initially, set status to "Server not detected, starting..."
- While polling, update to "Starting server... (X/30)"
- On success: "Server ready"
- On failure: "Server failed to start - check ~/.ghostbox/server.log"

---

## Phase 3: Terminal UI (Ink + React)

### Architecture

New entry point: `ghostbox tui` or standalone `ghostbox-tui` command.
Built with React Ink - same React mental model as web, Flexbox layout via Yoga.
Connects to `localhost:8008` API server (same as web + native).

### Layout (inspired by t1code)

```
+--[ GHOSTBOX ]--+---[ ghost > session-name ]-------+
| GHOSTS         |                                    |
|                | [assistant] Hello! How can I help? |
| * ghost    [R] |                                    |
|   session-1    | [you] Can you check the API?       |
|   session-2    |                                    |
|   + new session| [assistant] Sure, let me look...   |
|                |   [tool] bash: curl localhost:3000  |
| o ghost-2  [S] |   [result] {"status":"ok"}         |
|                |                                    |
| [+ Spawn]      |                                    |
|                +------------------------------------+
| Settings       | Talk to ghost...                   |
| Keybindings    | Press return to send               |
+----------------+----[Sonnet 4.6][9.9K / 1M]---------+
```

### Dependencies

```
ink (React terminal renderer)
@inkjs/ui (TextInput, Spinner, SelectInput components)
ink-markdown (message rendering)
react
```

### Key Components

- `GhostboxTUI` - root, two-column layout
- `Sidebar` - ghost list with status dots, session sublists, spawn button
- `ChatPane` - message list + input area
- `MessageList` - scrollable message stream with markdown rendering
- `ChatInput` - text input with slash command support
- `StatusBar` - model, context usage, keybindings hint

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+B | Toggle sidebar |
| Ctrl+N | New session |
| Ctrl+P | Switch ghost (cycle) |
| Tab | Focus cycle: sidebar -> chat -> input |
| Esc | Close overlays / cancel stream |
| Esc Esc | Message history mode |
| Up/Down | Navigate history (when in history mode) |
| Enter | Send message |
| Shift+Enter | Newline |

### Connection to API

Uses the same REST API + SSE as web/native:
- `GET /api/ghosts` - ghost list (poll or SSE events)
- `POST /api/ghosts/:name/message` - send message (SSE stream response)
- `GET /api/ghosts/:name/sessions` - session list (new)
- `POST /api/ghosts/:name/sessions/switch` - switch session (new)
- `POST /api/ghosts/:name/new` - new session
- `GET /api/events` - real-time sync (new)

### Entry Point

Add to `src/cli.ts`:
```
ghostbox tui     # launches TUI, auto-starts server if needed
```

TUI source lives in `src/tui/` directory.

---

## Files to Modify

### Phase 1 (Backend)
- `src/ghost-server.ts` - Add /sessions, /sessions/switch endpoints
- `src/orchestrator.ts` - Proxy new endpoints, auto-wake in sendMessage
- `src/api.ts` - Route new endpoints, SSE event bus, auto-wake in /message
- `src/types.ts` - SessionInfo, SessionListResponse types

### Phase 2 (Native)
- `native/Sources/Chat/AgentChatViewModel.swift` - sentHistory, historyIndex, double-escape
- `native/Sources/Chat/AgentChatView.swift` - history mode key handling
- `native/Sources/App/AppDelegate.swift` - better startup messaging
- `native/Sources/Services/GhostboxClient.swift` - wakeGhost call before chat if stopped

### Phase 3 (TUI - new files)
- `src/tui/index.tsx` - entry point
- `src/tui/app.tsx` - root component
- `src/tui/sidebar.tsx` - ghost list + session list
- `src/tui/chat.tsx` - chat pane
- `src/tui/input.tsx` - chat input with history
- `src/tui/status-bar.tsx` - footer
- `src/tui/api-client.ts` - REST + SSE client
- `src/cli.ts` - add `tui` command

## Success Criteria

- Can create new sessions, list old ones, switch between them from any client
- Clicking a stopped ghost in native app auto-wakes it
- Double-escape cycles through sent message history in native app
- `ghostbox tui` launches a working terminal interface
- All three clients stay in sync via SSE event bus
