# Version-Tracked Upgrades

Ghostbox tracks what image version each ghost is running and provides rolling upgrades when the base changes.

## How it works

### Image version

Every time the Docker image is built (during `init` or `upgrade`), a version hash is computed from the build artifacts:

```
SHA256(ghost-server.js + Dockerfile + entrypoint.sh + ghost-memory + qmd + ghost-save + exa-search)
```

The first 8 hex chars become the version label: `gb-75bb758c`.

This is stored in `state.json` as `config.imageVersion` and stamped onto each ghost when it's spawned or woken.

### ghostbox list

Shows the version column with current/stale indicators:

```
NAME        MODEL                  STATUS    VERSION                  PORTS
researcher  claude-sonnet-4-6      running   gb-75bb758c (current)    3100-3109
analyst     claude-sonnet-4-6      running   gb-a3f8c201 (stale)      3110-3119
dave        claude-sonnet-4-6      stopped                            3120-3129
```

- `(current)` - ghost is running the latest image
- `(stale)` - ghost is running an older image
- Empty version - ghost predates version tracking (treated as stale)

### ghostbox upgrade

Rebuilds the image and rolls through stale ghosts one at a time:

```bash
$ ghostbox upgrade
# 1. bun build src/ghost-server.ts -> docker/ghost-server.js
# 2. docker build -t ghostbox-agent docker/
# 3. Compute new image version
# 4. For each running ghost (one at a time):
#    - Skip if version matches (already current)
#    - Refresh auth (copy fresh auth.json from ~/.pi/agent/)
#    - Kill (commits vault first)
#    - Wake (creates new container from new image)
#    - Verify health check
#    - Stamp new version
# 5. Print summary

Upgraded: 2, Skipped: 1, Failed: 0
```

The upgrade is idempotent. Running it twice in a row skips everything on the second run.

### What triggers an upgrade

Only the explicit `ghostbox upgrade` command. Nothing happens automatically. You control the timing.

Typical workflow:
1. Make changes to ghost-server.ts, docker tools, or Dockerfile
2. Run `ghostbox upgrade`
3. All running ghosts get rolled to the new image
4. Check `ghostbox list` to verify

### Failure handling

If a ghost fails to wake after being killed:
- The error is logged
- The ghost stays in `stopped` state
- The upgrade continues to the next ghost
- The failed ghost is reported in the summary

You can manually investigate and `ghostbox wake <name>` to retry.

### Auth refresh

Every upgrade rollover copies fresh auth from `~/.pi/agent/auth.json` to the ghost's pi-agent directory. This ensures expired OAuth tokens are replaced without manual intervention.

### Stopped ghosts

Stopped ghosts are not restarted during upgrade. They will pick up the new image version when you next `ghostbox wake` them.

## State migration

Older state.json files without version fields are handled gracefully. On load, missing fields are backfilled:
- `config.imageVersion` defaults to `""`
- `ghost.imageVersion` defaults to `""`

Ghosts with empty versions are treated as stale and will be upgraded on the next `ghostbox upgrade`.
