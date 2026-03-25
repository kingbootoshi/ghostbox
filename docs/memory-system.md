# Memory System

Ghostbox agents have a two-layer memory system that persists across sessions, compactions, and container restarts.

## Overview

| Layer | Files | Mechanism | When |
|-------|-------|-----------|------|
| Warm memory | MEMORY.md, USER.md | Injected into system prompt | Every session start |
| Deep memory | Vault files (knowledge/, code/) | Searched on demand via qmd | When agent needs details |

Warm memory is the **map** - the agent always knows what it knows.
Deep memory is the **territory** - detailed knowledge retrieved when needed.

## Warm Memory

### MEMORY.md

Agent's personal notes. Environment facts, project conventions, file references, lessons learned. Free-form text with `§` delimiters between entries.

Example:
```
Acme API: Bun + Hono + PostgreSQL + Drizzle ORM + Stripe
§
Known bugs: orders POST no validation, O(N+1) in orders/:id, Stripe key hardcoded
§
Architecture notes in knowledge/acme-architecture.md
§
Fixed BUG-2847: added items array validation to orders POST endpoint
```

Limit: 4000 characters. When full, the agent must replace or remove entries before adding new ones.

### USER.md

What the agent knows about the user. Preferences, role, communication style, corrections.

Example:
```
Saint. Builds AI agent infrastructure. Terse responses, no emojis.
§
Prefers TypeScript strict. No any types. Bun only, never npm.
```

Limit: 2000 characters.

### Injection

Both files are read at session start and injected into the system prompt with usage indicators:

```
==================================================
MEMORY (your personal notes) [12% - 480/4000 chars]
==================================================
<contents of MEMORY.md>

==================================================
USER PROFILE (who the user is) [7% - 140/2000 chars]
==================================================
<contents of USER.md>
```

This refreshes on `/new` (new session) and `/compact` (context compaction) via `session.reload()`.

### Native tools

Memory is managed via Pi extension tools registered at `~/.ghostbox/base/extensions/memory.ts`. The agent calls these directly - no bash needed.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory_write` | target ("memory" or "user"), content | Add an entry |
| `memory_replace` | target, search (substring), content | Replace entry matching substring |
| `memory_remove` | target, search (substring) | Remove entry matching substring |
| `memory_show` | target (optional) | Show contents and usage stats |

Replace and remove use substring matching - provide a unique fragment of the entry you want to target. If multiple entries match, the tool returns an error and asks to be more specific.

The tools return results in the `AgentToolResult` format required by the Pi SDK: `{ content: [{ type: "text", text }], details: {} }`.

## Deep Memory

Detailed knowledge lives in vault markdown files under `knowledge/`, `code/`, or any directory the agent creates. The agent writes detailed notes here and keeps short pointers in MEMORY.md.

### CLI: qmd

```bash
# Search vault files by content
qmd search "stripe webhook"
qmd search "rate limit" --type md

# Read a specific file
qmd read knowledge/acme-architecture.md
qmd read knowledge/arch.md --section "Database"  # extract by heading

# Navigate the vault
qmd list "*.md"          # list markdown files
qmd tree 3               # directory tree (depth 3)
qmd scan                 # all files with first-line summaries
qmd recent 10            # 10 most recently modified files
qmd headings arch.md     # show headings in a file
qmd summary              # vault overview with stats
```

## Pre-compaction Flush (Nudge System)

Before context is lost, the nudge system gives the agent one final turn to save anything it missed.

### When it fires

1. Before `/compact` - agent gets one turn to save from the conversation being compressed
2. Before `/new` - agent gets one turn to save from the session being replaced

### How it works

1. The NudgeRegistry emits a `pre-compact` or `pre-new-session` event
2. The memory-observer handler calls `flushMemories()`
3. `flushMemories()` sends a system prompt via `session.prompt()` telling the agent to save
4. The agent calls `memory_write` to save any unsaved facts
5. Flush artifacts (the prompt and response) are stripped from session history

Critical events (`pre-compact`, `pre-new-session`) always await completion before proceeding.

### Nudge API

Nudges can be triggered from outside the container:

```bash
# From the host CLI
ghostbox nudge <name> pre-compact "manual flush"

# Via HTTP
curl -X POST http://localhost:3100/nudge \
  -H "Authorization: Bearer <api-key>" \
  -d '{"event":"pre-compact","reason":"manual"}'

# From inside the container
ghost-nudge memory
ghost-nudge self "reason"
```

## The Workflow

### During a session

1. Agent starts - MEMORY.md and USER.md are in its system prompt
2. Agent checks warm memory for relevant context before responding
3. Agent uses `qmd search` to find related vault files
4. Agent does work, learns new things
5. Agent saves quick facts via `memory_write`
6. Agent writes detailed notes: creates files in `knowledge/`
7. Agent maps new files: `memory_write` with a pointer to the file

### On compaction or new session

1. Nudge system fires - agent gets one turn to flush unsaved facts
2. `session.reload()` refreshes the system prompt with latest files
3. New session starts with updated warm memory
4. Agent picks up where it left off

### Across sessions

The agent maintains continuity through its warm memory. Each session starts with the accumulated knowledge of all previous sessions. The agent knows what project it manages, what tickets it handled, what files it created, and what issues remain.

## What to save where

| What | Where | Why |
|------|-------|-----|
| User corrections and preferences | USER.md | Highest priority - prevents repeat corrections |
| Tech stack, conventions | MEMORY.md | Quick recall every session |
| File references ("notes at knowledge/x.md") | MEMORY.md | Navigation map for deep memory |
| Ticket history ("Fixed BUG-2847") | MEMORY.md | Continuity across sessions |
| Architecture details, research | knowledge/*.md | Too detailed for warm memory |
| Code, scripts, tools | code/ | Persistent projects |
| Custom agent extensions | .pi/extensions/ | Self-evolution |

## What NOT to save

- Task progress or temporary state (ephemeral)
- Things already in git history (use `git log`)
- Duplicate information across warm and deep memory
- Raw data dumps (summarize instead)
