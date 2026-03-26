# Heartbeat Scheduler + Notifications + Ghost Sprites

## 1. Cron/Heartbeat Scheduler

### Problem
Ghosts can't schedule their own work. No way to set recurring pings, morning briefings, proactive follow-ups, or heartbeat checks.

### Solution
Add a cron scheduler to the host API server that:
- Persists schedules to ~/.ghostbox/schedules.json
- Fires prompts to ghosts on schedule (auto-wakes if stopped)
- Exposes a ghost-side tool so agents can set their own schedules
- Supports one-shot and recurring schedules

### Architecture

**Host side (api.ts):**
- ScheduleManager class that loads/saves schedules
- setInterval loop (every 30s) checks for due schedules
- When schedule fires: wake ghost if stopped, POST /message with the scheduled prompt
- REST endpoints:
  - GET /api/ghosts/:name/schedules - list schedules
  - POST /api/ghosts/:name/schedules - create schedule
  - DELETE /api/ghosts/:name/schedules/:id - remove schedule

**Ghost side (ghost-server.ts):**
- New tool: `schedule` - agent can call this to create/list/delete its own schedules
- Tool calls host API via GHOST_API_KEY to manage schedules
- Tool params: { action: "create"|"list"|"delete", cron?: string, prompt?: string, id?: string, once?: boolean }

**Schedule format:**
```json
{
  "id": "uuid",
  "ghostName": "ghost",
  "cron": "0 10 * * *",
  "prompt": "Good morning! Check on my projects and give me a briefing.",
  "timezone": "America/Los_Angeles",
  "once": false,
  "enabled": true,
  "createdAt": "2026-03-26T...",
  "lastFired": null,
  "nextFire": "2026-03-27T10:00:00..."
}
```

**Heartbeat:**
- Special schedule type: `{ type: "heartbeat", interval: 3600 }`
- Default prompt: "Heartbeat check. Review your memory, check if there's anything you should follow up on or proactively do for the user."
- Configurable per ghost in state.json

### Files to modify
- src/api.ts - schedule endpoints, scheduler loop
- src/ghost-server.ts - schedule tool for agents
- src/types.ts - GhostSchedule type
- src/orchestrator.ts - proxy schedule endpoints

---

## 2. macOS Notifications

### Problem
When a ghost sends a message, the user has no idea unless they're looking at the app.

### Solution
Native macOS notifications when a ghost responds. Clicking opens the ghost's chat.

### Implementation

**AppDelegate.swift:**
- Request notification permissions on launch
- Register UNNotificationCenter delegate

**AgentChatViewModel.swift:**
- When SSE stream receives an assistant message AND app is not active/focused:
  - Fire UNNotificationRequest with ghost name as title, message preview as body
  - Set categoryIdentifier for action handling
  - Include ghostName in userInfo

**Notification content:**
- Title: "ghost" (ghost name)
- Body: first 100 chars of assistant message
- Sound: default
- Category: "GHOST_MESSAGE"

**Click handling (AppDelegate):**
- UNUserNotificationCenterDelegate.didReceive response
- Extract ghostName from userInfo
- Call openChat(ghostName:)
- Activate app

**Theme:**
- Use UNNotificationContent - can't deeply customize macOS notification appearance
- But app icon (ghost pixel art) shows automatically
- Badge the dock icon with unread count

### Files to modify
- native/Sources/App/AppDelegate.swift - notification setup, delegate
- native/Sources/Chat/AgentChatViewModel.swift - fire notifications on new messages
- native/Sources/App/AppState.swift - unread count tracking

---

## 3. Ghost Sprites

### Problem
Ghosts have no visual identity. The hub and chat show just text.

### Solution
Animated ghost sprites next to ghost names. Different animations for different states.

### Assets
Located at ~/Documents/assets/ghost/:
- Blink.gif - idle blink
- DoubleBlink.gif - idle variant
- Excited.gif - new message / spawn
- Idle.gif - default state
- LookingAround.gif - waiting for response
- Talking.gif - streaming/typing

### State mapping
| Ghost state | Animation |
|-------------|-----------|
| Stopped | Idle (static first frame) |
| Running, idle | Blink or Idle (random) |
| Running, streaming | Talking |
| Just received message | Excited (briefly) |
| Waiting for user | LookingAround |

### Implementation

**AnimatedGhostView.swift (new):**
- NSViewRepresentable wrapping NSImageView
- Load GIF from bundle resources
- Play animation matching current state
- Small size: 24x24 in hub rows, 20x20 in chat header

**Integration:**
- GhostRowView.swift - show sprite before ghost name
- ChatHeaderView.swift - show sprite before ghost name
- Copy GIF assets into native/Resources/GhostSprites/

**Future: AI-generated hats**
- On ghost spawn, generate a small hat/accessory using PixelLab MCP
- Save to ghost state
- Composite onto sprite at runtime
- Each ghost gets unique identity

### Files to modify
- native/Sources/Chat/AnimatedGhostView.swift (new)
- native/Sources/Hub/GhostRowView.swift - add sprite
- native/Sources/Chat/ChatHeaderView.swift - add sprite
- native/Resources/GhostSprites/ (new - copy assets)
- native/project.yml - include resources
