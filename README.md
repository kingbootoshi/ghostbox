<p align="center">
  <img src="documents/assets/ghostbox-banner-8.jpeg" alt="Ghostbox" width="100%">
</p>

# Ghostbox

Persistent AI agents in isolated Docker containers. Each ghost gets its own vault, its own memory, and evolves across sessions.

---

## What is this

Ghostbox spawns AI agents that live in Docker containers. Each agent has:

- A **vault** - persistent git-backed filesystem that survives restarts
- A **memory system** - warm facts injected into every session + deep knowledge searchable on demand
- **Full coding capabilities** - file I/O, bash, package installation, server hosting
- **Self-evolution** - agents build their own tools, refine their own instructions, grow their knowledge base

The host orchestrator manages container lifecycle, routes messages via Telegram or the REST API, and handles git persistence. A native macOS app provides a local interface.

## The idea

One agent per repo. Each agent becomes the master engineer - understands the architecture, tracks known issues, handles dispatch requests, preserves context across sessions. When context compacts or sessions restart, the agent picks up exactly where it left off because its memory persists in the vault.

```
You (CEO/Architect)
 |
 +-- Ghost: acme-api      "Hono + Drizzle + Stripe. 3 open bugs."
 +-- Ghost: mobile-app     "React Native 0.76. Release cut Thursday."
 +-- Ghost: infra          "Terraform + Fly.io. DNS migration in progress."
 +-- Ghost: data-pipeline  "Kafka -> Clickhouse. Backfill running."
```

Each ghost maintains its own:
- Architecture knowledge in `/vault/knowledge/`
- Dispatch history in `/vault/MEMORY.md`
- User preferences in `/vault/USER.md`
- Code changes in `/vault/code/`
- Custom tools in `/vault/.pi/extensions/`

## Quick start

```bash
# Install
git clone https://github.com/kingbootoshi/ghostbox.git
cd ghostbox
bun install

# Initialize (builds Docker image, sets up config)
bun run src/cli.ts init

# Spawn a ghost
bun run src/cli.ts spawn researcher --model anthropic/claude-sonnet-4-6

# Talk to it
bun run src/cli.ts talk researcher "Explore the codebase and save what you learn"

# Start the Telegram bot
bun run src/cli.ts bot
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
|  | api.ts    |->|               |  |   |  ghost-memory + qmd    |
|  +-----------+  +----+----------+  |   +------------------------+
|                      |             |
|                 +----+----+        |   +------------------------+
|                 | vault   |        |   | ghostbox-analyst       |
|                 | (git)   |        +-->|  /vault (mounted)      |
|                 +---------+        |   |  ghost-server.ts       |
+------------------------------------+   +------------------------+
```

## Memory system

Each ghost has a two-layer memory system inspired by [Hermes Agent](https://github.com/nousresearch/hermes-agent):

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

Managed via the `ghost-memory` CLI inside the container:

```bash
ghost-memory add memory "Deployment uses Fly.io with 2 replicas"
ghost-memory add user "Prefers TypeScript strict, no any"
ghost-memory replace memory "2 replicas" "3 replicas after scaling incident"
ghost-memory remove memory "outdated fact"
ghost-memory show
```

### Deep memory (vault files via qmd)

Detailed knowledge lives in vault markdown files. Warm memory holds pointers; `qmd` retrieves the details.

```bash
qmd search "stripe webhook"     # ripgrep through vault
qmd read knowledge/arch.md      # read a file
qmd scan                        # list all files with summaries
qmd tree                        # vault structure
```

### Memory observer

A cheap model (Haiku 4.5) reviews conversations before compaction and extracts facts worth saving. Fires automatically on `/compact`, `/new`, and every 10 messages.

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
| Memory | MEMORY.md + USER.md (Hermes-style) |
| Vault search | qmd (ripgrep-based) |
| Observer | Anthropic Haiku 4.5 |
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

Every ghost container ships with:

| Tool | Purpose |
|------|---------|
| `ghost-memory` | Manage warm memory (add/replace/remove facts) |
| `qmd` | Search and read vault files |
| `ghost-save` | Git commit + push vault to GitHub |
| `exa-search` | Web and code search via Exa |

Plus full coding tools via the Pi Agent SDK: file I/O, bash, ripgrep, git, package managers.

## Configuration

State lives at `~/.ghostbox/state.json`. Key config fields:

```json
{
  "config": {
    "defaultModel": "anthropic/claude-sonnet-4-6",
    "imageName": "ghostbox-agent",
    "imageVersion": "gb-75bb758c",
    "observerModel": "anthropic/claude-haiku-4-5-20251001"
  }
}
```

Set `observerModel` to enable the memory observer. Leave empty to disable.

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

## Eval

The memory system includes an evaluation harness that simulates a full engineering lifecycle:

```bash
bun run tests/eval-memory.ts <ghost-name>
```

Tests onboarding, bug fixes, feature implementation, compaction survival, and deep recall across multiple session boundaries. Scored 21/21 on Claude Sonnet 4.6.

## License

MIT
