# Personal workspace for `default` users

**Date:** 2026-09-07 · **Status:** approved in chat (option ข.)

## Goal
Every multi-user `default`-role user has at least one workspace of their own. Access to any other
workspace stays invite-only (unchanged: `Workspace.whereWithUser` already scopes non-admin users
to `workspace_users` membership).

## Non-goals
- `default` users creating extra workspaces, renaming, or configuring their workspace
  (`/workspace/new`, `/workspace/:slug/update` etc. stay admin/manager-only).
- Owner/role columns on `workspace_users`. No schema change.
- Backfill migration. Existing users get theirs lazily (see below).

## Behaviour
On `GET /workspaces` (`server/endpoints/workspaces.js`), when **all** hold:
1. multi-user mode is on,
2. `user.role === "default"`,
3. the user has zero workspaces,

the server creates one workspace named `"<username>'s workspace"` via the existing
`Workspace.new(name, user.id)` (which links `workspace_users` and de-duplicates slugs), then returns
the list including it. Any other call path returns the list unchanged.

Consequences accepted: a `default` user whose last workspace is deleted or unshared gets a fresh
personal one on next list. Admin/manager never get one auto-created.

## Implementation
- `server/models/workspace.js`: `ensurePersonal(user)` — returns `{ workspace, created }`; no-op
  unless the three conditions above hold. Name constant lives beside it with a comment.
- `server/endpoints/workspaces.js` list route: call `ensurePersonal` before `whereWithUser` when
  `multiUserMode(response)`.
- Errors from creation are logged and swallowed; the list still returns (a failed auto-create must
  not break the sidebar).

## Tests (`server/__tests__/endpoints/workspacePersonal.test.js`, jest, prisma mocked)
1. default user, no workspaces → `Workspace.new` called once with `("<username>'s workspace", user.id)`; response contains it.
2. default user, already has one → `Workspace.new` not called.
3. admin user, no workspaces → not called.
4. single-user mode → not called.

## Security
Touches an authorization path. Final review: Opus + `security-review`. Key check: creation is
tied to `response.locals.user` from session only; request body/query never influence name or owner.
