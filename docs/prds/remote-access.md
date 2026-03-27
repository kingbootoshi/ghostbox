# PRD: Remote Access - API Auth, Configurable URL, CORS

## Goal

Enable Ghostbox to be hosted on a Mac Mini (or any server) and accessed remotely from the native macOS app, TUI, and CLI via a Cloudflare Tunnel. Currently all API routes except mail are unauthenticated and clients are hardcoded to localhost.

## Track 1: API Auth on All Routes

### Current State
- Only `/api/mail/*` has bearer auth middleware (src/api.ts:1191)
- 36+ other routes are completely open
- Auth pattern: parse `Authorization: Bearer <token>`, match against ghost API keys or `GHOSTBOX_ADMIN_TOKEN`
- On match, stores `{ authenticatedBy, ghostName }` in request context via `c.var.mailAuth`
- `GHOSTBOX_ADMIN_TOKEN` exists (src/api.ts:186) but only used as mail user auth fallback

### Changes

1. **Generalize auth middleware** from mail-only to all API routes:
   - Rename `mailAuth` context var to `apiAuth` throughout
   - Move `app.use("/api/mail/*", ...)` auth middleware to `app.use("/api/*", ...)`
   - Place it AFTER CORS middleware, BEFORE route handlers
   - The middleware logic stays the same: check bearer token against ghost keys and admin token

2. **Exempt health check**: Add `GET /api/health` BEFORE the auth middleware so it's unauthenticated. Return `{ status: "ok", version: "..." }`. Cloudflare Tunnel needs this for health probes.

3. **Auto-generate admin token on first run**: In the CLI `init` command or on first API server start, if `GHOSTBOX_ADMIN_TOKEN` is not set and `state.config.adminToken` doesn't exist, generate one with `crypto.randomBytes(32).toString('hex')`, save to `state.config.adminToken`, and print it once.

4. **Token resolution order**:
   - Check bearer token against all ghost API keys first (ghost identity)
   - Then check against `state.config.adminToken` (admin/user identity)
   - Then check against `GHOSTBOX_ADMIN_TOKEN` env var (legacy/override)
   - If none match: 401

5. **Admin vs ghost permissions**: For now, both get full access. The auth context just records WHO is calling. Future: scope ghost keys to their own ghost's routes only.

### Files to modify
- `src/api.ts` - middleware scope, context var rename, health endpoint
- `src/types.ts` - add `adminToken` to config type if not present

## Track 2: Configurable API URL + Auth Token in Clients

### Native macOS App

**Current state**: Hardcoded `http://localhost:8008` in GhostboxClient.swift:139. No auth headers. Settings screen edits server config, not app connection settings.

**Changes**:
1. Add `serverURL` and `serverToken` to UserDefaults (stored client-side, not server-side)
2. `GhostboxClient` init takes optional `baseURL` and `token` parameters
3. If `token` is set, add `Authorization: Bearer <token>` header to EVERY request (both normal and SSE streaming)
4. Add "Connection" section to HubSettingsView with URL and token fields
5. When URL is empty or not set, default to `http://localhost:8008` (current behavior)
6. Remove or make optional the auto-launch of `bun run src/api.ts` when URL points to non-localhost

### TUI

**Current state**: `GHOSTBOX_API_URL` env var exists in api-client.ts:3. No auth headers.

**Changes**:
1. Add `GHOSTBOX_API_TOKEN` env var support
2. If set, add `Authorization: Bearer <token>` to all requests in the `request()` function and the streaming function
3. That's it - the URL config already works

### CLI

**Current state**: CLI commands call orchestrator functions directly (not via API). For remote access, the CLI needs to talk to the remote API instead.

**Note**: This is a larger refactor (CLI -> API client instead of direct function calls). For now, just add:
1. `ghostbox remote set <url>` - saves URL to `~/.ghostbox/remote.json`
2. `ghostbox remote token <token>` - saves token to `~/.ghostbox/remote.json`
3. `ghostbox remote status` - shows current remote config
4. `ghostbox remote clear` - removes remote config

The actual CLI-over-API routing is a future task. The remote config just needs to exist so the TUI and native app can read it.

## Track 3: CORS Lockdown

### Current State
- `app.use("/api/*", cors({ origin: "*" }))` at src/api.ts:1167

### Changes
1. Read allowed origins from `state.config.corsOrigins` (string array)
2. Default to `["http://localhost:8008", "http://localhost:3000", "tauri://localhost", "ghostbox://"]`
3. If `GHOSTBOX_CORS_ORIGINS` env var is set, parse as comma-separated and merge
4. Pass the array to `cors({ origin: allowedOrigins })`

## Testing
- All existing tests must pass
- New tests for: auth middleware on non-mail routes, health endpoint bypass, admin token generation, CORS origin checking
- Run `bun test` and `bun run typecheck` after implementation

## Non-Goals
- CLI-over-API routing (future)
- Per-ghost route scoping (future)
- Database migration (not needed)
- Cloudflare Tunnel setup (already done by user)
