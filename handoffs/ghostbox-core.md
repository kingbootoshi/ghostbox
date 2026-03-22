# Handoff: ghostbox-core

**Identity:** ghostbox-core
**Updated:** 2026-03-01T11:10:00Z
**Project:** ~/dev/ghostbox/

## Current Goal

Build and debug Ghostbox - a system for spawning isolated AI agents in Docker containers, controlled via Telegram. We're in the "first ghost is alive, fixing issues as they surface" phase.

## Accomplished This Session

- Fixed Dockerfile: added `unzip` for Bun installer
- Fixed init flow: state saves BEFORE Docker build (so credentials survive build failures), with re-use prompt on re-init
- Fixed vault.ts: added `git config user.name/email` per ghost so commits work
- Fixed Dockerfile: added `NODE_PATH=/usr/local/lib/node_modules` for Agent SDK resolution
- Fixed Dockerfile: added symlink `/node_modules/@anthropic-ai/claude-agent-sdk` -> global install (ESM resolution)
- Implemented full centralized logging via Codex agent:
  - Created `src/logger.ts` (Pino + pino-pretty, createLogger factory)
  - Updated `src/cli.ts` with logger + bot pre-flight checks (Docker reachable, Telegram token valid)
  - Updated `src/telegram.ts` with command logging, bot.catch(), onStart log
  - Updated `src/orchestrator.ts` with spawn/kill/wake/health-check logging
  - Updated `src/vault.ts` with git operation logging
  - Updated `src/ghost-server.ts` with request/response logging (simple console wrapper, not pino - runs in container)
  - Created `src/claude-agent-sdk.d.ts` ambient declaration for typecheck
- Successfully spawned first ghost ("ghost") via Telegram
- Ghost responded, wrote files to vault, explored its filesystem
- Identified timeout issue: long-running agent queries timeout the orchestrator fetch

## Immediately Next

Fix ghost-server observability and timeout issues:
1. **Log SDK messages inside ghost-server.ts** - every tool_use, assistant chunk, result message. So `docker logs` shows the ghost working in real time instead of just request/response
2. **Remove or extend fetch timeout** in orchestrator.ts `sendMessage()` - long agent queries (web browsing, complex tasks) can take 5+ minutes
3. **Stream intermediate updates to Telegram** - at minimum tool-use notifications so user sees the ghost is working

## Decisions Made

- **Pino for host logging, simple console wrapper for container** - pino isn't installed in the Docker image, ghost-server uses a minimal formatted console logger
- **Each ghost gets git identity from its name** - `git config user.name "ghost"`, `user.email "ghost@ghostbox.local"`
- **State saves before Docker build in init** - UX improvement so credentials survive build failures
- **NODE_PATH + symlink for SDK resolution** - npm global install doesn't work with ESM imports by default, needed both NODE_PATH env var and a symlink at `/node_modules/` for Node to find the package
- **1 GB memory per ghost** - sufficient for chat + light code work, user confirmed
- **OpenRouter for all models** - not direct Anthropic API, configured via ANTHROPIC_BASE_URL env var

## Blockers / Open Questions

- Timeout on long-running ghost queries - needs fetch timeout extension + streaming progress
- ghost-server logs only request/response, not SDK internals (tool calls, thinking) - needs enhancement
- No Telegram command for viewing container logs yet
- Haven't tested: /kill, /wake, /save (git push to GitHub), /merge, session resume
- Haven't tested spawning multiple ghosts simultaneously

## Files Modified + Why

| File | Change | Why |
|------|--------|-----|
| `docker/Dockerfile` | Added unzip, NODE_PATH, symlink | Bun install needs unzip; SDK ESM resolution broken without NODE_PATH + symlink |
| `src/logger.ts` | NEW - Pino logger factory | Centralized logging, was zero observability before |
| `src/cli.ts` | Logger integration, bot pre-flight checks | Bot command was hanging silently with no output |
| `src/telegram.ts` | Command logging, bot.catch, onStart | Zero observability on telegram side |
| `src/orchestrator.ts` | Spawn/kill/wake/health logging | Couldn't see container lifecycle |
| `src/vault.ts` | Git op logging, user.name/email config | Git commits failed without user config; no visibility on vault ops |
| `src/ghost-server.ts` | Simple console logger for req/res | Container had no logging |
| `src/claude-agent-sdk.d.ts` | NEW - ambient type declaration | Typecheck passes without SDK installed on host |
| `src/types.ts` | Unchanged | - |
| `package.json` | Added pino, pino-pretty deps | Logger dependencies |
| `tsconfig.json` | Include src/**/*.d.ts | For ambient declaration |

## Uncommitted Changes

Everything is uncommitted. The entire project has no commits beyond the initial scaffold:
```
 M bun.lock
 M package.json
 M tsconfig.json
?? docker/
?? src/
```

## Army State

No codex agents currently running. Used 3 agents this session:
1. `d2e7e024` - Fixed init flow (state save before build, re-use config) - COMPLETED
2. `c84bbc77` - Research: logging/error handling plan - COMPLETED
3. `6c2e03bd` - Implementation: centralized logging across all files - COMPLETED

## Key Context for Next Session

- The ghost "ghost" may still be running in Docker (`docker ps` to check)
- State file at `~/.ghostbox/state.json` has all credentials
- Ghost vault at `~/.ghostbox/ghosts/ghost/vault/`
- The ghost already wrote `knowledge/first-session.md` to its vault
- OpenRouter key, Telegram token, GitHub token all configured and working
- Docker image `ghostbox-agent` is built and working
- Bot starts with `bun run src/cli.ts bot`

## SDK Capabilities Researched But Not Yet Implemented

Full Agent SDK research completed. Key unused features:
- `mcpServers` in query() options - per-ghost MCP servers
- `agents` in query() options - subagent definitions (different models, restricted tools)
- `createSdkMcpServer()` + `tool()` - custom in-process tools
- `hooks` in query() options - PreToolUse, PostToolUse, SubagentStart/Stop, etc.
- `settingSources: ["project"]` - loads CLAUDE.md from vault as config
- `outputFormat` - structured JSON responses
- `maxBudgetUsd`, `maxTurns` - per-query cost controls
- `enableFileCheckpointing` - filesystem rewind
- `plugins` - local plugin loading from vault
