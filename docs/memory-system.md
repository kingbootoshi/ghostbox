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

### CLI: ghost-memory

```bash
# Add entries
ghost-memory add memory "Project uses Bun on host, Node 22 in containers"
ghost-memory add user "Prefers terse responses"

# Update by substring match (finds entry containing "Bun on host", replaces entire entry)
ghost-memory replace memory "Bun on host" "Project uses Bun on host, Deno in edge workers"

# Remove by substring match
ghost-memory remove memory "outdated fact"

# View current state with usage
ghost-memory show
ghost-memory show memory   # just MEMORY.md
ghost-memory show user     # just USER.md
```

Replace and remove use substring matching - provide a unique fragment of the entry you want to target. If multiple entries match, the command fails and asks you to be more specific.

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

## Memory Observer

An optional cheap model (Haiku 4.5 or GPT nano) that reviews conversations and extracts facts before context is lost.

### When it fires

1. Before `/compact` - extracts facts from the conversation being compressed
2. Before `/new` - extracts facts from the session being replaced
3. Every 10 messages - background nudge (non-blocking)

### What it does

1. Reads the conversation history (last ~30k chars)
2. Reads current MEMORY.md and USER.md
3. Calls the observer model with a structured extraction prompt
4. Parses the response for memory operations (add/replace/remove)
5. Executes operations via the ghost-memory CLI

### Configuration

Set `observerModel` in state.json config:

```json
{
  "config": {
    "observerModel": "anthropic/claude-haiku-4-5-20251001"
  }
}
```

Leave empty to disable. The observer uses the Pi SDK's OAuth tokens from auth.json - supports both Anthropic and OpenAI providers.

### Auth

The observer reads OAuth tokens from `/root/.pi/agent/auth.json` inside the container. For Anthropic, it refreshes expired tokens automatically. The token is used with standard Anthropic Messages API headers including the `anthropic-beta: oauth-2025-04-20` flag.

## The Workflow

### During a session

1. Agent starts - MEMORY.md and USER.md are in its system prompt
2. Agent checks warm memory for relevant context before responding
3. Agent uses `qmd search` to find related vault files
4. Agent does work, learns new things
5. Agent saves quick facts: `ghost-memory add memory "..."`
6. Agent writes detailed notes: creates files in `knowledge/`
7. Agent maps new files: `ghost-memory add memory "Notes at knowledge/topic.md"`

### On compaction or new session

1. Observer fires (if configured) - extracts facts from conversation
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
