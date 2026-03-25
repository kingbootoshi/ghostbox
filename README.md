<p align="center">
  <img src="documents/assets/ghostbox-banner-8.jpeg" alt="Ghostbox" width="100%">
</p>

# Ghostbox

Persistent AI agents in isolated Docker containers. Each ghost gets its own vault, its own memory, and evolves across sessions.

---

## What is this

Ghostbox lets you create isolated AI agents, each with their own sandboxed environment and persistent vault. Agents self-evolve - building tools, refining instructions, growing their knowledge base - and save their updates to GitHub.

Each agent has:

- A **vault** - persistent git-backed filesystem that survives restarts
- A **memory system** - warm facts injected into every session + deep knowledge searchable on demand
- **Full coding capabilities** - file I/O, bash, package installation, server hosting
- **Self-evolution** - agents build their own tools, refine their own instructions, grow their knowledge base

The host orchestrator manages container lifecycle, routes messages via Telegram or the REST API, and handles git persistence. A native macOS app provides a local interface.

## Quick start

```bash
npx @bootoshi/ghostbox init
```

This runs the setup wizard: configures API keys, builds the Docker image, and creates your first ghost.

```bash
# Spawn a ghost
ghostbox spawn researcher --model anthropic/claude-sonnet-4-6

# Talk to it
ghostbox talk researcher "Explore the codebase and save what you learn"

# Start the Telegram bot
ghostbox bot
```

## Architecture

```
Host (Bun)                               Docker Containers
+------------------------------------+
|  CLI / API / Telegram              |   +------------------------+
|                                    |   | ghostbox-researcher    |
|  +-----------+  +---------------+  |   |  /vault (mounted)      |
|  | telegram  |->| orchestrator  |--+-->|  ghost-server.ts       |
|  +-----------+  +---------------+  |   |  Pi Agent SDK          |
|  | api.ts    |->|               |  |   |  memory + qmd          |
|  +-----------+  +----+----------+  |   +------------------------+
|                      |             |
|                 +----+----+        |   +------------------------+
|                 | vault   |        |   | ghostbox-analyst       |
|                 | (git)   |        +-->|  /vault (mounted)      |
|                 +---------+        |   |  ghost-server.ts       |
+------------------------------------+   +------------------------+
```

## Memory system

Each ghost has a two-layer memory system:

### Warm memory (MEMORY.md + USER.md)

Plain text files with `§`-delimited entries. Injected into the system prompt at session start. The agent sees these immediately without running tools.

```
== MEMORY (your personal notes) [12% - 480/4000 chars] ==
Acme API: Bun + Hono + PostgreSQL + Drizzle ORM + Stripe
§
Fixed BUG-2847: added items validation to orders POST
§
Architecture notes in knowledge/acme-architecture.md

== USER PROFILE (who the user is) [7% - 140/2000 chars] ==
Saint. Builds AI agent infrastructure. Terse responses, no emojis.
```

Managed via native Pi extension tools (no CLI needed):

- `memory_write` - add an entry (target: "memory" or "user")
- `memory_replace` - replace an entry by substring match
- `memory_remove` - remove an entry by substring match
- `memory_show` - show contents and usage stats

### Deep memory (vault files via qmd)

Detailed knowledge lives in vault markdown files. Warm memory holds pointers; `qmd` retrieves the details.

```bash
qmd search "stripe webhook"     # ripgrep through vault
qmd read knowledge/arch.md      # read a file
qmd scan                        # list all files with summaries
qmd tree                        # vault structure
```

### Pre-compaction flush

Before context compacts or sessions reset, the nudge system gives the agent one final turn to save anything it missed using `memory_write`. Artifacts from the flush are stripped from history so they don't pollute the next context window.

### The pattern

Warm memory is the **map**. Deep memory is the **territory**.

MEMORY.md tells the agent what it knows and where to find details. When it needs the full picture, it reads vault files via `qmd`. After learning something new, it saves a quick note to warm memory and writes details to a vault file.

## CLI commands

| Command | Description |
|---------|-------------|
| `ghostbox init` | Setup wizard - configure keys, build Docker image |
| `ghostbox spawn <name> [--model M]` | Create and start a new ghost |
| `ghostbox list` | Show all ghosts with version tracking |
| `ghostbox upgrade` | Rebuild image, rolling restart stale ghosts |
| `ghostbox talk <name> <msg>` | Send a message, stream response |
| `ghostbox kill <name>` | Stop ghost (commits vault first) |
| `ghostbox wake <name>` | Restart a stopped ghost |
| `ghostbox save <name>` | Git commit + push vault |
| `ghostbox merge <src> <dst>` | Merge two ghost vaults |
| `ghostbox rm <name>` | Delete ghost and vault |
| `ghostbox nudge <name> [event] [reason]` | Trigger a nudge event on a ghost |
| `ghostbox bot` | Start Telegram bot |
| `ghostbox keys <name>` | Manage API keys |

### Version-tracked upgrades

```bash
$ ghostbox list
NAME          MODEL                  STATUS    VERSION                  PORTS
researcher    claude-sonnet-4-6      running   gb-75bb758c (current)    3100-3109
analyst       claude-sonnet-4-6      running   gb-a3f8c201 (stale)      3110-3119

$ ghostbox upgrade
Upgraded: 1, Skipped: 1, Failed: 0
```

`ghostbox upgrade` rebuilds the image, computes a version hash, then rolls through stale ghosts one at a time. Current ghosts are skipped. Auth is refreshed on every rollover.

## Stack

| Component | Technology |
|-----------|-----------|
| Host runtime | Bun |
| Container runtime | Node.js 22 |
| Agent SDK | Pi Coding Agent |
| Framework | Hono (API server) |
| Docker | dockerode |
| Telegram | grammY |
| Persistence | Git (per vault) |
| Memory | Native Pi extension (MEMORY.md + USER.md) |
| Vault search | qmd (ripgrep-based) |
| Native app | SwiftUI (macOS) |

## Vault structure

Each ghost's persistent filesystem:

```
/vault/
  CLAUDE.md             # Ghost identity and instructions
  MEMORY.md             # Warm memory (injected each session)
  USER.md               # User profile (injected each session)
  knowledge/            # Research notes, architecture docs, runbooks
  code/                 # Cloned repos, scripts, projects
  .pi/extensions/       # Custom Pi agent tools (self-evolution)
  .git/                 # Everything versioned
```

The vault is mounted from the host. Everything else in the container is throwaway. Ghosts can `apt-get install`, compile code, run servers in the ephemeral layer. Only `/vault` survives restarts.

## Container tools

Every ghost container has:

**Native tools** (Pi extension, called directly by the agent):

| Tool | Purpose |
|------|---------|
| `memory_write` | Add entry to warm memory (MEMORY.md or USER.md) |
| `memory_replace` | Replace entry by substring match |
| `memory_remove` | Remove entry by substring match |
| `memory_show` | Show memory contents and usage stats |
| `web_search` | Web search via Exa |
| `code_search` | Code search via Exa |

**Bash CLI tools:**

| Tool | Purpose |
|------|---------|
| `qmd` | Search and read vault files |
| `ghost-save` | Git commit + push vault to GitHub |
| `ghost-changelog` | Log significant changes |
| `ghost-nudge` | Trigger nudge events from inside the container |
| `exa-search` | Web and code search via Exa (CLI alternative) |

Plus full coding tools via the Pi Agent SDK: file I/O, bash, ripgrep, git, package managers.

## Configuration

State lives at `~/.ghostbox/state.json`. Base extensions and agent config live at `~/.ghostbox/base/`.

```json
{
  "config": {
    "defaultModel": "anthropic/claude-sonnet-4-6",
    "imageName": "ghostbox-agent",
    "imageVersion": "gb-75bb758c"
  }
}
```

## API server

REST API on port 3200 for programmatic control:

```bash
# List ghosts
curl http://localhost:3200/api/ghosts

# Send message (SSE stream)
curl -X POST http://localhost:3200/api/ghosts/researcher/message \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What do you know about the auth module?"}'

# Read vault files
curl http://localhost:3200/api/ghosts/researcher/vault/knowledge/notes.md
```

## License

MIT
