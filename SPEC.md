# Ghostbox

Spawn isolated AI agents in Docker containers. Talk to them via Telegram. Each ghost gets its own sandboxed filesystem, its own model (via OpenRouter), and a git-backed vault that persists across container restarts.

## Core Concept

A "ghost" is an LLM agent running inside a Docker container with the Claude Agent SDK. It has full Claude Code capabilities (file read/write/edit, bash, grep, glob) but is jailed to its own vault directory. It cannot see the host, other ghosts, or anything outside `/vault`.

The orchestrator runs on the host (your Mac Mini). It manages container lifecycle, routes messages from Telegram to ghosts, and handles git persistence.

## Stack

- Runtime: Bun (host orchestrator + Telegram bot)
- Agent runtime: Node.js 22 (inside Docker containers, required by Claude Agent SDK)
- Agent SDK: `@anthropic-ai/claude-agent-sdk` (inside containers)
- LLM routing: OpenRouter (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`)
- Telegram: grammY
- Docker: dockerode (programmatic container management)
- Persistence: git (one repo per ghost vault)
- State: JSON file (`~/.ghostbox/state.json`)

## Project Structure

```
ghostbox/
  src/
    cli.ts              # CLI entry point + setup wizard
    orchestrator.ts     # Container lifecycle, state management
    telegram.ts         # grammY bot, command routing
    vault.ts            # Git init/commit/push/merge per ghost
    ghost-server.ts     # Runs INSIDE container - HTTP wrapper around Agent SDK
    types.ts            # Shared type definitions
  docker/
    Dockerfile          # Ghost runtime image
  package.json
  tsconfig.json
  SPEC.md
  CLAUDE.md
```

Seven source files. One Dockerfile. That is the entire project.

## Architecture

```
Host (Mac Mini)                          Docker Containers
+----------------------------------+     +---------------------+
|  ghostbox (Bun process)          |     | ghost: researcher   |
|                                  |     |  /vault (mounted)   |
|  +----------+  +--------------+  |     |  ghost-server:3000  |
|  | telegram |->| orchestrator |--+---->|  Agent SDK -> LLM   |
|  +----------+  +--------------+  |     +---------------------+
|                      |           |
|                      |           |     +---------------------+
|                +-----+-----+     |     | ghost: analyst      |
|                | vault.ts  |     |     |  /vault (mounted)   |
|                | (git ops) |     |     |  ghost-server:3000  |
|                +-----------+     +---->|  Agent SDK -> LLM   |
+----------------------------------+     +---------------------+
```

### Communication flow

1. User sends message in Telegram
2. grammY bot receives it, looks up which ghost is active for that chat
3. Orchestrator sends HTTP POST to the ghost's container (mapped port)
4. ghost-server inside container calls Agent SDK `query()` with the prompt
5. Agent SDK streams response messages back
6. ghost-server streams them back over HTTP
7. Orchestrator relays text back to Telegram

### Container isolation

Each ghost container:
- Mounts `~/.ghostbox/ghosts/<name>/vault/` as `/vault` (read-write)
- Has 10 mapped ports on localhost (API + 9 user ports, auto-assigned in blocks of 10 starting at 3100)
- Gets model-specific env vars injected at creation
- Runs as root inside container (Docker provides isolation, not user permissions)
- Can install packages, compile code, run servers
- Has no access to host filesystem beyond its vault mount
- Default: `--network=bridge` (needs outbound for LLM API calls and user-run servers)
- Optional: custom network policies for tighter lockdown

### What runs where

| Component | Where | Runtime |
|-----------|-------|---------|
| CLI | Host | Bun |
| Orchestrator | Host | Bun |
| Telegram bot | Host | Bun |
| Vault (git) | Host | Bun (shell out to git) |
| ghost-server | Container | Node.js 22 |
| Agent SDK | Container | Node.js 22 (spawns Claude Code CLI internally) |

## Ghost Server (ghost-server.ts)

This is the only file that runs inside the container. It is a minimal HTTP server that wraps the Claude Agent SDK.

### Endpoints

**POST /message**

Request body:
```json
{
  "prompt": "analyze the files in this vault",
  "sessionId": "optional-session-id-for-resume"
}
```

Response: newline-delimited JSON stream (NDJSON). Each line is one SDK message:
```json
{"type": "assistant", "text": "I'll analyze the vault contents..."}
{"type": "tool_use", "tool": "Bash", "input": "ls /vault"}
{"type": "tool_result", "output": "notes.md\nresearch/\n..."}
{"type": "assistant", "text": "I found the following files..."}
{"type": "result", "text": "Analysis complete. Found 12 files...", "sessionId": "abc-123"}
```

The stream ends with a `result` message that includes the session ID for future resume.

**GET /health**

Returns `{"status": "ok"}`. Used by orchestrator to check container readiness.

### Agent SDK configuration inside the container

```typescript
const response = query({
  prompt: userPrompt,
  options: {
    cwd: '/vault',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    model: process.env.GHOSTBOX_MODEL,
    resume: sessionId || undefined,
    maxTurns: 50,
    systemPrompt: process.env.GHOSTBOX_SYSTEM_PROMPT || defaultPrompt,
  },
  env: {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: '',
    IS_SANDBOX: '1',
  },
});
```

Key details:
- `cwd: '/vault'` sets the default working directory to the vault (persistent layer)
- Ghost can still access the full container filesystem via Bash (throwaway layer)
- `bypassPermissions` because there is no human in the container to approve tool use
- `IS_SANDBOX: '1'` required for bypassPermissions when running as root
- Session resume via saved session ID
- Model and system prompt configurable per ghost via env vars
- Ghost can install packages, run servers, compile code - full root access inside container

## Dockerfile

```dockerfile
FROM node:22-slim

# Install Agent SDK (includes Claude Code CLI) and common dev tools
RUN npm install -g @anthropic-ai/claude-agent-sdk@latest && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates \
      python3 python3-pip python3-venv \
      curl wget jq \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install Bun (ghosts may want to run Bun servers)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Vault directory
RUN mkdir -p /vault

# Copy the ghost server
COPY ghost-server.js /ghost-server.js

# Run as root - ghosts need to install packages, run servers, self-evolve.
# Isolation is provided by Docker, not by user permissions.
WORKDIR /vault
EXPOSE 3000 8001-8009

CMD ["node", "/ghost-server.js"]
```

The image runs as root inside the container. This lets ghosts install packages (`apt-get install`, `pip install`, `bun add`), compile code, and run servers. Docker provides the isolation boundary - root inside the container has zero access to the host beyond the mounted vault.

The image should be built once and reused for all ghosts. Only env vars differ between containers.

### Port allocation

Each ghost gets 10 ports: 1 for the ghost-server API, 9 for user services.

```
Ghost "researcher":  host 3100 -> container 3000 (API)
                     host 3101-3109 -> container 8001-8009 (user ports)

Ghost "analyst":     host 3110 -> container 3000 (API)
                     host 3111-3119 -> container 8001-8009 (user ports)
```

When a ghost runs a server (e.g. `bun serve` on port 8001), it is accessible on the host at the mapped port. The ghost can report the URL to the user, and it is reachable via Tailscale from any device on your network.

## State Management

All state lives in `~/.ghostbox/state.json`:

```json
{
  "ghosts": {
    "researcher": {
      "containerId": "abc123...",
      "portBase": 3100,
      "model": "anthropic/claude-sonnet-4.5",
      "sessionId": "session-xyz",
      "status": "running",
      "createdAt": "2026-02-17T...",
      "systemPrompt": "You are a research agent..."
    },
    "analyst": {
      "containerId": "def456...",
      "portBase": 3110,
      "model": "kimi/kimi-k2.5-instruct",
      "sessionId": null,
      "status": "stopped",
      "createdAt": "2026-02-17T...",
      "systemPrompt": null
    }
  },
  "config": {
    "openrouterKey": "sk-or-...",
    "telegramToken": "123456:ABC...",
    "githubToken": "ghp_...",
    "githubRemote": "git@github.com:user/ghostbox-vaults.git",
    "defaultModel": "anthropic/claude-sonnet-4.5",
    "imageName": "ghostbox-agent"
  },
  "telegram": {
    "activeChatGhosts": {
      "123456789": "researcher"
    }
  }
}
```

### Directory structure on host

```
~/.ghostbox/
  state.json
  ghosts/
    researcher/
      vault/           # Mounted into container as /vault
        .git/
        notes.md
        research/
        ...
    analyst/
      vault/
        .git/
        ...
```

## CLI Commands

### `ghostbox init`

Interactive setup wizard:

1. Check Docker is installed and running
2. Check git is installed
3. Ask for OpenRouter API key (validate with a test call)
4. Ask for Telegram bot token (validate by calling getMe)
5. Optionally ask for GitHub token + remote URL for vault backups
6. Ask for default model (suggest `anthropic/claude-sonnet-4.5`)
7. Build the ghost Docker image (`ghostbox-agent`)
8. Save config to `~/.ghostbox/state.json`
9. Print summary

### `ghostbox spawn <name> [options]`

Options:
- `--model <model>` - OpenRouter model ID (default: config default)
- `--prompt <text>` - Custom system prompt for this ghost

Steps:
1. Create `~/.ghostbox/ghosts/<name>/vault/` directory
2. Initialize git repo in the vault
3. Assign next available port (starting at 3100)
4. Create and start Docker container with:
   - Volume mount: vault dir -> /vault
   - Port mapping: assigned port -> 3000
   - Env vars: OpenRouter config, model, system prompt
   - Image: ghostbox-agent
   - Container name: `ghostbox-<name>`
5. Wait for health check to pass
6. Save ghost state to state.json
7. Print "Ghost <name> is alive on port <port>"

### `ghostbox list`

Print table of all ghosts:
```
NAME        MODEL                           STATUS    PORTS
researcher  anthropic/claude-sonnet-4.5     running   3100-3109
analyst     kimi/kimi-k2.5-instruct         stopped   3110-3119
```

### `ghostbox talk <name> "<message>"`

Send a message to a ghost via CLI. Stream the response to stdout.

### `ghostbox kill <name>`

1. Save current session ID to state.json
2. Git commit any uncommitted changes in the vault
3. Stop and remove the Docker container
4. Set status to "stopped" in state.json

### `ghostbox wake <name>`

1. Re-create Docker container with same config
2. Resume session using saved sessionId
3. Set status to "running"

### `ghostbox save <name>`

1. Git add + commit all changes in the vault
2. If GitHub remote configured, git push
3. Print commit hash

### `ghostbox merge <source> <target>`

1. Both ghosts must be stopped
2. In target's vault, add source vault as git remote
3. Git merge source into target
4. Remove the git remote
5. Print merge result (or conflicts to resolve)

### `ghostbox logs <name>`

Tail the Docker container logs.

### `ghostbox rm <name>`

1. Kill the ghost if running
2. Remove the vault directory (move to trash)
3. Remove from state.json

### `ghostbox bot`

Start the Telegram bot (long-running process). This is also started automatically by `ghostbox init` as a background process, or can be run separately.

## Telegram Bot

Uses grammY with long polling. Single bot, multiple ghost routing.

### Commands

- `/start` - Welcome message, explain how Ghostbox works
- `/spawn <name> [model]` - Create a new ghost (uses default model if not specified)
- `/list` - Show all ghosts and their status
- `/talk <name>` - Set the active ghost for this chat (subsequent messages go to it)
- `/switch <name>` - Alias for /talk
- `/kill <name>` - Stop a ghost
- `/wake <name>` - Resume a ghost
- `/save [name]` - Git save active or named ghost
- `/merge <source> <target>` - Merge vaults
- `/model <name> <model>` - Change a ghost's model
- `/status` - Show which ghost is active in this chat

### Message handling

When a user sends a non-command message:
1. Look up active ghost for this Telegram chat ID
2. If no active ghost, reply "No active ghost. Use /talk <name> to pick one."
3. Send prompt to ghost via orchestrator
4. Stream response back as Telegram messages
5. For long responses, send in chunks (Telegram has 4096 char limit per message)
6. Show "typing" indicator while ghost is working

### Error handling

- If ghost container is not running: "Ghost <name> is sleeping. Use /wake <name> to wake it."
- If ghost takes too long (>120s): "Ghost <name> is still thinking... send another message to follow up or /kill to stop."
- If container crashes: detect via health check, report to user, save state

## Vault Git Operations (vault.ts)

Simple git wrapper. All operations shell out to `git` via Bun's subprocess.

### Functions

- `initVault(name)` - git init, create initial commit with `.gitignore`
- `commitVault(name, message?)` - git add -A && git commit (auto-generate message if not provided)
- `pushVault(name)` - git push to configured remote
- `mergeVaults(source, target)` - add remote, fetch, merge, remove remote
- `getVaultStatus(name)` - git status (clean/dirty, commit count, last commit date)

### .gitignore (default for each vault)

```
node_modules/
.env
*.tmp
.DS_Store
```

## Orchestrator (orchestrator.ts)

Manages the full lifecycle. Uses dockerode for programmatic Docker control.

### Functions

- `spawnGhost(name, model, systemPrompt?)` - create vault + container, start, wait for health
- `killGhost(name)` - save session, commit vault, stop + remove container
- `wakeGhost(name)` - re-create container, pass saved sessionId for resume
- `sendMessage(name, prompt)` - HTTP POST to container, return async iterator of response chunks
- `listGhosts()` - return all ghosts with status
- `removeGhost(name)` - full cleanup
- `getGhostHealth(name)` - ping health endpoint
- `mergeGhosts(source, target)` - delegate to vault.ts

### Port management

Ports are auto-assigned in blocks of 10 starting at 3100. Ghost N gets ports `3100 + (N * 10)` through `3100 + (N * 10) + 9`. First port is the API, remaining 9 are for user services. When a ghost is removed, its port block is freed. State.json tracks port assignments.

### Container creation (dockerode)

```typescript
const basePort = getNextPortBlock(); // e.g. 3100, 3110, 3120...

const portBindings: Record<string, Array<{ HostPort: string }>> = {
  '3000/tcp': [{ HostPort: String(basePort) }],
};
// Map user ports 8001-8009 to host ports basePort+1 through basePort+9
for (let i = 1; i <= 9; i++) {
  portBindings[`${8000 + i}/tcp`] = [{ HostPort: String(basePort + i) }];
}

const container = await docker.createContainer({
  Image: 'ghostbox-agent',
  name: `ghostbox-${name}`,
  Env: [
    `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
    `ANTHROPIC_AUTH_TOKEN=${config.openrouterKey}`,
    `ANTHROPIC_API_KEY=`,
    `GHOSTBOX_MODEL=${model}`,
    `GHOSTBOX_SYSTEM_PROMPT=${systemPrompt || ''}`,
    `GHOSTBOX_GITHUB_TOKEN=${config.githubToken || ''}`,
    `GHOSTBOX_USER_PORTS=8001-8009`,
    `GHOSTBOX_HOST_BASE_PORT=${basePort}`,
    `IS_SANDBOX=1`,
  ],
  ExposedPorts: {
    '3000/tcp': {},
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`${8001 + i}/tcp`, {}])
    ),
  },
  HostConfig: {
    Binds: [`${vaultPath}:/vault`],
    PortBindings: portBindings,
    Memory: 1024 * 1024 * 1024,  // 1GB limit (ghosts may compile/run code)
    CpuShares: 512,
  },
});
```

## OpenRouter Model Configuration

Each ghost gets its model via env vars. The Agent SDK inherits these from the container environment.

### Env vars passed to each container

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<openrouter_api_key>
ANTHROPIC_API_KEY=                          # must be empty
GHOSTBOX_MODEL=<model_id>                   # e.g. anthropic/claude-sonnet-4.5
GHOSTBOX_GITHUB_TOKEN=<github_pat>          # optional, for cloning/pushing repos
GHOSTBOX_HOST_BASE_PORT=<port>              # so the ghost knows its external ports
GHOSTBOX_USER_PORTS=8001-8009               # available ports for user services
```

### Supported model examples

Any model on OpenRouter that supports the Anthropic messages API format:
- `anthropic/claude-sonnet-4.5` - Claude Sonnet 4.5
- `anthropic/claude-opus-4` - Claude Opus 4
- `kimi/kimi-k2.5-instruct` - Kimi K2.5
- `deepseek/deepseek-r2` - DeepSeek R2
- `google/gemini-2.5-pro` - Gemini 2.5 Pro
- `openai/gpt-4.1` - GPT 4.1

Note: Claude Agent SDK relies on tool use capabilities. Models that do not support tool use well will have degraded agent behavior (no file editing, no bash, etc.). The strongest tool-use models are Claude, GPT-4+, and Gemini 2.5 Pro.

## Two-Layer Filesystem

Each ghost has two distinct filesystem layers:

### /vault - Persistent, git-backed, sacred

This is mounted from the host (`~/.ghostbox/ghosts/<name>/vault/`). It survives container death, gets committed to git, pushes to GitHub. This is the ghost's real work.

```
/vault/
  CLAUDE.md              # Ghost's identity, instructions, personality
  knowledge/             # Accumulated notes, research, memory
    MEMORY.md            # Key insights and learnings
    research/            # Topic-specific research
    decisions/           # Decision logs
  code/                  # Long-term projects
    my-project/          # Cloned GitHub repos
    tools/               # Scripts and utilities the ghost builds for itself
  .git/                  # Everything is versioned
```

The ghost can clone repos into `/vault/code/`, work on them, commit, push. It can build up a knowledge base in `/vault/knowledge/`. It can create tools for itself in `/vault/code/tools/`. All of this persists and is backed up.

### Everything else - Throwaway sandbox

The rest of the container filesystem (`/root`, `/tmp`, `/home`, `/opt`, etc.) is ephemeral. When the container dies, it is gone. The ghost is root and can do whatever it wants here:

- `apt-get install` packages
- `pip install` libraries
- Download and compile random things
- Run experiments
- Spin up test servers
- Install Rust, Go, whatever

This is scratch paper. The ghost uses it to try things out. If something works and is worth keeping, the ghost moves it into `/vault`. If the container restarts, installed packages are gone but the vault is intact.

### Why this matters

The ghost can `git clone` your repo into `/vault/code/my-project/`, install dependencies in the throwaway layer, run the project, iterate on it, commit changes back. The dependencies disappear on container restart but the code changes are saved. Next session, the ghost reinstalls deps (or the system prompt can tell it to run a setup script it wrote for itself).

### GitHub access

If a GitHub token is configured, the ghost can:
- Clone private repos into `/vault/code/`
- Push changes back to GitHub
- The token is passed as env var `GHOSTBOX_GITHUB_TOKEN`
- The ghost can use it via `git clone https://<token>@github.com/user/repo.git`

### Self-Evolution

Because the vault persists and the ghost has full root access:

1. Session 1: Ghost researches a topic, writes notes to `/vault/knowledge/`
2. Session 2: Ghost reads old notes, writes a Python script in `/vault/code/tools/`
3. Session 3: Ghost installs deps in throwaway layer, runs its own tool, refines it
4. Session 4: Ghost has a growing toolkit and knowledge base it built for itself
5. Eventually: Ghost writes its own CLAUDE.md updates to refine its own behavior

The vault is the ghost's brain. The throwaway layer is its workbench.

## Build & Development

### Dependencies (host - package.json)

```json
{
  "name": "ghostbox",
  "type": "module",
  "bin": {
    "ghostbox": "./dist/cli.js"
  },
  "dependencies": {
    "grammy": "^1.39",
    "dockerode": "^4.0",
    "chalk": "^5.0"
  },
  "devDependencies": {
    "@types/dockerode": "^4.0",
    "@types/bun": "latest",
    "typescript": "^5.0"
  }
}
```

### Build steps

1. `bun install`
2. `bun build src/ghost-server.ts --target=node --outfile=docker/ghost-server.js --external @anthropic-ai/claude-agent-sdk` (bundle for container, SDK is installed globally in image)
3. `docker build -t ghostbox-agent docker/` (build the agent image)
4. `bun build src/cli.ts --outfile=dist/cli.js --target=bun` (build CLI)

### Running in development

```bash
bun run src/cli.ts init        # setup
bun run src/cli.ts spawn test  # spawn a ghost
bun run src/cli.ts bot         # start telegram bot
```

## Phase 1 Deliverables (MVP)

Everything described in this spec. The full system:

1. CLI with all commands (init, spawn, list, talk, kill, wake, save, merge, logs, rm, bot)
2. Docker container with ghost-server + Agent SDK
3. Telegram bot with all commands
4. Git-backed vault persistence
5. OpenRouter model routing
6. Session resume across container restarts

## Non-Goals (for now)

- Web UI
- Agent-to-agent direct messaging (use merge for now)
- Cloudflare/cloud deployment (design supports it later via swappable runner)
- Authentication beyond Telegram chat ID
- Rate limiting
- Cost tracking per ghost
- MCP server integration inside ghosts

## Constraints

- Bun runtime on host, Node.js inside containers
- No npm/yarn/pnpm - Bun only on host
- No emojis in code or output
- No em dashes
- Minimal dependencies
- Seven source files max for v1
- One Dockerfile
