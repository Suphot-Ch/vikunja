# Primus deployment changes

## 2.8.0-primus.1 — 2026-11-19

- Merge the official Vikunja v2.8.0 release (`6e788bf87cebe50e2b8d034b213fcf94ae5449ee`) while preserving the previously deployed custom task real-time functionality.
- Port task create/update/delete refreshes to the upstream TanStack Vue Query cache rather than retaining the removed legacy Kanban Pinia store.
- Preserve upstream authentication/session security and optional-feature license checks. Use canonical project access checks for custom WebSocket recipients and minimal invalidation payloads.
- Send separate source-project invalidations after cross-project moves, authorized against current source access without disclosing destination project metadata.
- Prepare unprivileged writable application/file and temporary directories in the scratch image; verify SQLite writes and temporary dumps without writable mounts.
- Enable the release's native MCP endpoint at `/api/v2/mcp`; use scoped API tokens with `mcp:access`, not login JWTs or an external adapter.
- Rehearse PostgreSQL migration against an isolated restored copy before any production rollout. Keep runtime credentials, database/file backups, build artifacts and task plans outside Git.

Verification results and deployment status are recorded separately; this entry is not a claim that production has been upgraded.
