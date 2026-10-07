# Agent finalization: avoid SQLite read-lock upgrade

## Approved scope

Base `f43be3da6d5d5f3091d5b2e6d4961c5f7fa973ea`. User approved the bounded
agent-close fix, then commit/push/build/deploy to existing VKE and live testing.
No PostgreSQL migration, database settings change, MCP key change, dependency
change, retry loop, or schema changes.

## Diagnosis

Real model + temporary SQLite with competing writer reproduced silently lost
finalization: Prisma timeout, close returns undefined, row stays closed=false.
Natural two-client contention with an unrelated-row batch write reproduced
17/20 failures, repeated 16/20; conditional updateMany control failed 0/20 both
times. Original Prisma update emits BEGIN/SELECT/UPDATE/readback/COMMIT;
updateMany emits BEGIN/UPDATE/COMMIT, avoiding read-to-write lock upgrade.
The original production lock holder is not established.

## Fix and regression

Only model close implementation changed: updateMany scoped by uuid and
closed=false. Missing/already-closed invocations are harmless; errors log a short
code-only message instead of disappearing. It still contains errors for the
fire-and-forget WebSocket callback. No claim that permanent locks cannot fail.

New actual-SQLite regressions cover concurrent unrelated writer, repeated/missing
close, concurrent close isolated to target, and observable controlled failure.
Initial tests failed persistence and absence of error log before implementation.
Original natural repro after implementation: 0/20 failures, no timeout errors.

Verification: 95 tracked server suites / 1,469 tests passed; scoped model ESLint,
Prettier and diff checks passed. New regression file is explicitly added despite
existing models test-directory ignore (other model tests are already tracked).

Independent reviewer dispatch unavailable; no independent-review claim. Bare
root Jest's prior child-worktree/helper collection/heap failure remains; explicit
tracked server paths used, not exhaustive collector/browser-companion/E2E.

## Release testing contract

Live smoke must await persisted invocation.closed=true before deleting fixtures:
the previous smoke resolved as soon as client close was requested, allowing its
cleanup transaction to race server finalization. Updated temporary harnesses
assert persistence before cleanup for no-tool agent and both real tool agents.
No synthetic database lock or production stress will be injected. Previous VKE
image/template saved before update, only app image changes, production memory off.
Digest and production result recorded separately after rollout.

Temporary logs: agent-close-red.log, agent-close-release-suite.log,
agent-finalization-contention.log, agent-finalization-contention-repeat.log,
agent-finalization-fixed.log. No MCP/PG credentials searched or changed.
