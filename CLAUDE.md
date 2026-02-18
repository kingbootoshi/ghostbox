# Ghostbox

Spawn isolated AI agents in Docker containers. Talk to them via Telegram.

## Stack

- Host runtime: Bun (CLI, orchestrator, Telegram bot)
- Container runtime: Node.js 22 (ghost-server + Claude Agent SDK)
- Telegram: grammY
- Docker: dockerode
- LLM: OpenRouter (any model)
- Persistence: git per vault

## Structure

```
ghostbox/
  src/
    cli.ts              # CLI entry point + setup wizard
    orchestrator.ts     # Container lifecycle, state management
    telegram.ts         # grammY bot, command routing
    vault.ts            # Git init/commit/push/merge per ghost
    ghost-server.ts     # Runs INSIDE container - HTTP wrapper around Agent SDK
    types.ts            # Shared types
  docker/
    Dockerfile          # Ghost runtime image
```

## Constraints

- Use Bun for everything on the host
- Use `trash` for deletions, never `rm`
- No emojis in code or output
- No em dashes
- No npm/yarn/pnpm - Bun only
- TypeScript strict, no `any`
- Keep it minimal - seven source files max
- Research unfamiliar APIs with Exa before coding
- Do not guess at library APIs - look them up

## Key Patterns

- ghost-server.ts must be bundled to a single JS file for the container (no node_modules in image for this file)
- The Agent SDK npm package IS installed globally in the container image (it includes Claude Code CLI)
- All Docker management via dockerode, not shell commands
- All git operations via Bun subprocess (shell out to git)
- State lives in ~/.ghostbox/state.json (single JSON file)
- Vault directories at ~/.ghostbox/ghosts/<name>/vault/

## OpenRouter Config

Ghosts use OpenRouter via env vars:
```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<openrouter_key>
ANTHROPIC_API_KEY=        # must be empty string
GHOSTBOX_MODEL=<model_id>
```

## Building

```bash
bun install
bun build src/ghost-server.ts --target=node --outfile=docker/ghost-server.js
docker build -t ghostbox-agent docker/
```

## Running

```bash
bun run src/cli.ts init
bun run src/cli.ts spawn <name> --model <model>
bun run src/cli.ts bot
```
