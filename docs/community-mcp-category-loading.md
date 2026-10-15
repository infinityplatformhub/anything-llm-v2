# Personal Medusa category loading

Locally verified 2026-10-09. This implementation does not activate a production
connector or change FlowAccount/TNV, Admin/Lark login, SQLite/PVC/keys or sidecars.

## Opt-in after release approval

Keep the existing authenticated `redball-store` connector configuration and add
`categoryLoading: true` to its `anythingllm` object. `perUserAuth` must already be
true; non-personal configurations reject category loading. Preserve existing OAuth
settings; new Medusa scopes require consent and are never silently added to grants.

Deploy client support with adapter full discovery first. Enable adapter index mode
only after the combined client/backend/adapter release is explicitly approved and
the actual live baseline/rollback has been checked. Full remains the adapter default.

## Behavior and safety

- The model starts with a static category index and requests schemas when needed;
  the user does not manually select categories.
- Only authenticated results from this configured personal server can register
  private forwarding closures. Arbitrary tool/store text cannot register code.
- Loaded schemas are invocation-local and bound to user/workspace/server/generation,
  personal grant and catalog revision; no bearer lives in that state.
- Both actual streaming/non-streaming agent loops refresh the next provider's
  functions, pin discovery/loaded tools across reranking and reject unloaded calls.
- Limits stay 24 execution tools / 65,536 UTF-8 schema bytes. Malformed, forged,
  colliding, stale, oversized or aborted loads reject atomically. Tool-call depth is
  not reset. A fresh invocation may reload schemas; no cross-turn persistence.
- Connection ownership/config/generation is rechecked immediately before dispatch
  and after the result, including reconnect during boot. Revocation/disconnect
  denies even when old schemas are cached.

## Evidence

115 server suites / 1,612 tests and 3 MCP E2E suites / 22 tests pass. New modules
pass configured ESLint; affected client runtime files parse on Node 18.

The companion Redball native fixture uses real disposable Medusa/SDK plus actual
AIbitat loops, two users and both execution modes with a deterministic provider.
Separately, Layer/PersonalMcpRuntime tests use real SQLite grants with external SDK
network mocked. These are complementary seam checks, not one fully unmocked client
OAuth/Lark/live-model session and not a production deployment claim.
