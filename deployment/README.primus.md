# Vikunja 2.8.0-ch.1 rollout

## Scope

This branch merges official `v2.8.0` (peeled commit `6e788bf87cebe50e2b8d034b213fcf94ae5449ee`) with the previously deployed Kanban task-realtime customisation. The original checkout and deployed binary are not changed by preparing this branch.

- Preserve realtime task create/update/delete notifications, with canonical inherited project access and minimal `{id, project_id}` payloads. Cross-project moves also emit a separate internal source-project invalidation without disclosing the destination to source-only viewers.
- Use the upstream TanStack Vue Query event path, including related parent-detail refreshes and reconnect invalidation. Do not retain the removed legacy Pinia Kanban store.
- Retain upstream license checks, session revocation and native MCP authorization.
- Native MCP is the official **POST** `/api/v2/mcp` Streamable HTTP endpoint, not a sidecar adapter.
- Runtime image builds use a minimal context: tested static binary, public CA bundle and an empty writable `/tmp`. Never send private backups, agent caches, environment files or the whole task-board directory as build context.

## Verification commands

Run the frontend with Node 24+ and the pinned package manager from `frontend/package.json`:

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run \
  src/client/queries/serverEvents.test.ts \
  src/client/queries/serverEvents.context.test.ts \
  src/client/queries/contextMutation.test.ts \
  src/composables/useWebSocket.test.ts \
  src/composables/useServerCacheEvents.test.ts \
  src/composables/useServerCacheEvents.tasks.test.ts \
  src/client/queries/kanbanMutations.test.ts \
  src/components/project/views/ProjectKanban.test.ts \
  src/views/user/settings/Mcp.test.ts \
  src/components/token/McpClientGuide.test.ts \
  --maxWorkers=1 --no-file-parallelism
pnpm exec eslint src/client/queries/serverEvents.ts
pnpm typecheck
pnpm build
```

The pinned i18n/Vitest stack can fail virtual-locale imports under parallel files; serial execution is required for this verification run. A root-owned `frontend/dist` created by an earlier container can also cause a build write failure. Correct only that generated directory's ownership; do not change source permissions broadly.

Run Go API tests through Mage, not plain `go test`:

```sh
go tool mage test:filter 'TestMCP|TestCallTool|TestBuildToolSpec|TestTaskListener|TestTaskEventsAreSubscribable|TestGetUserIDsForProject|TestConnection|TestNotificationListener|TestTimeEntryListener'
```

When using a Git worktree from Docker, mount its common Git directory read-only as well as the worktree, and set `GIT_WORK_TREE` to the container worktree. A `.git` pointer whose target is absent inside the container causes Mage's version discovery to fail.

Build the runtime with Go 1.27 and musl's C toolchain, after a successful frontend build:

```sh
CGO_ENABLED=1 go build -trimpath -tags 'osusergo netgo' \
  -ldflags '-s -w -linkmode external -extldflags -static -X code.vikunja.io/api/pkg/version.Version=2.8.0-ch.1' \
  -o <minimal-context>/vikunja .
# Also copy the public system CA bundle and create both
# <minimal-context>/runtime-root/files/ and <minimal-context>/tmp/.
docker build -f deployment/Dockerfile.primus-runtime \
  --build-arg RELEASE_VERSION=2.8.0-ch.1 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t local/vikunja:2.8.0-ch.1 <minimal-context>
```

The binary should report `2.8.0-ch.1`; save its SHA-256 and the image ID with the verified source commit.

## Migration gate

**Production migration/deployment requires explicit approval.** Do not infer approval from source merge or a successful staging build.

1. Take a fresh custom-format PostgreSQL dump, file archive, original Compose configuration and original binary/image identity into private storage. Restrict backup permissions. Never commit or publish them.
2. Restore the dump into a separate PostgreSQL 16 instance on an **internal** Docker network. Mount only an isolated copy of attachments. Disable registration, mail, reminders and user deletion there. Never connect staging to production database credentials/host.
3. Compare record counts, ID fingerprints and a task-content fingerprint before migration. Start the new candidate against the restored copy; confirm core data survives the migrations.
4. Test login and existing `/api/v1` CLI reads; browser navigation/Kanban refresh; native MCP initialize, tool discovery, CRUD with exact readback, token revocation and denied access controls.
5. Only after gates and approval: stop production application writes, take the final backup, switch the exact application container/image/binary, run migrations, then re-check the domain, data and authorized MCP client.

## Native MCP and Hermes

Create a separate expiring API token as Pemo. Grant `mcp:access` plus only the task/project/comment permissions the agent needs; no account/admin/webhook/sharing permissions and no deletes unless explicitly needed. Login JWTs are intentionally rejected.

The authenticated `/api/v2/mcp/info` route describes the real endpoint and available scope presets. The settings page can generate client configuration. Resource permissions remain enforced by the REST handlers, independently of tool discovery.

Use official Hermes MCP CLI/configuration tooling. Keep the token in the active profile's secret scope, not YAML source or Git. The server entry can reference it without embedding its value:

```yaml
mcp_servers:
  vikunja:
    url: https://task.supht.com/api/v2/mcp
    headers:
      Authorization: Bearer ${env:VIKUNJA_MCP_TOKEN}
    skip_preflight: true
    sampling:
      enabled: false
```

The server is POST-only; a failed GET/HEAD preflight is not proof that native MCP is down. Verify a real initialize and `tools/list`, then call a read tool and read back a scoped test write. Missing `readOnlyHint` annotations are not a read-only guarantee; token scopes are the enforced limit.

## Rollback

Migrations are not reversed by switching the application binary. If production rollout fails, keep the application stopped, restore the verified pre-upgrade PostgreSQL dump and matching files/configuration, then restore the old image/binary and verify login/task reads before reopening writes. Rehearsal proves that the backup can be restored, not that production rollback has already been performed.

Verification artifacts and the local task plan are ignored. Reports must distinguish local commits, pushed branch SHA, staging runtime and production runtime; no layer implies another.
