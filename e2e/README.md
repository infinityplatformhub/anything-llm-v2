# Workspace agent E2E tests

## Prerequisites

- Docker with Compose
- Node.js 22 installed at `/opt/homebrew/opt/node@22`
- `AIG_API_KEY` exported in the shell

Run the full suite from the repository root:

```bash
AIG_API_KEY="$AIG_API_KEY" yarn test:e2e
```

The runner starts Docker fixtures, two app servers, the collector, and Vite. It writes logs to `e2e/logs/` (`server-A.log`, `server-B.log`, `collector.log`, and `frontend.log`). Normal runs stop all services and remove Docker volumes on exit.

Keep services running after the full suite for debugging:

```bash
AIG_API_KEY="$AIG_API_KEY" E2E_KEEP_UP=1 yarn test:e2e
```

The runner prints retained PIDs. While those services remain up, run one Jest suite with the same runtime environment:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
E2E_A_URL=http://localhost:3011 \
E2E_B_URL=http://localhost:3012 \
E2E_LOG_A="$PWD/e2e/logs/server-A.log" \
E2E_LOG_B="$PWD/e2e/logs/server-B.log" \
E2E_STORAGE_A="$PWD/e2e/.state/A/storage" \
E2E_STORAGE_B="$PWD/e2e/.state/B/storage" \
AIG_API_KEY="$AIG_API_KEY" \
npx jest -c e2e/jest.e2e.config.cjs e2e/suites/20-isolation.test.js
```

Stop retained host processes using the printed PIDs, then stop fixture containers with:

```bash
docker compose -f e2e/docker-compose.e2e.yml down -v
```

## Harness environment variables

| Variable | Effect |
| --- | --- |
| `AIG_API_KEY` | Required. Gateway key for the LLM provider. The runner refuses to start without it. |
| `AIG_BASE_URL` | Override the gateway base URL from `e2e/gateway.json`. |
| `AIG_MODEL` | Override the gateway model from `e2e/gateway.json`. |
| `E2E_KEEP_UP=1` | Leave Docker fixtures and host processes running after the run and print their PIDs. |
| `E2E_SKIP_UI=1` | Skip the Playwright UI suite. The run still ends `E2E_RESULT=FAIL reason=UI suite skipped` — this is a debugging aid for iterating on Jest, never a way to get a green run. |

## Ports

The runner owns `3010` (Vite), `3011` (server A), `3012` (server B), and `8888` (collector). Before touching any state it fails fast with `E2E_RESULT=FAIL reason=port <n> already in use (pid ...)` if any of them is already in LISTEN, then verifies after each service starts that the PID it launched is the PID bound to that port, and confirms on exit that all four are free again. This exists because a stale server from a previous run silently served a whole suite and reported product failures that were not real.

Docker fixture ports (`55432`, `53306`, `51433`, `58080`) are published on `127.0.0.1` only — those databases use weak fixture credentials and must not be reachable from the LAN.

## Test contract

`/v1` developer API keys are instance-global by design. They are admin-equivalent credentials, not workspace-membership credentials. Membership isolation uses JWT workspace routes instead.

`test.todo` cases are phase markers for behavior not implemented yet. Intentional skips live in `e2e/SKIPS.md`, one ` :: ` record per pending Jest test. `e2e/run.sh` compares that record count with Jest `numPendingTests + numTodoTests`; any undocumented or stale skip makes the final verdict fail.

`e2e/run.sh` also pins `numTotalTests` to `EXPECTED_TOTAL_TESTS` (currently 75), so deleting or renaming a suite file fails the verdict instead of quietly reporting PASS with less coverage. Change both together when the suite legitimately grows.

Every absence assertion carries a positive control, because a chat that never started an agent would otherwise read as a pass. On the `/v1` path that control is `Attached httpSocket plugin to Agent cluster` (always attached — `server/utils/agents/ephemeral.js`). On the JWT/UI path `stream-chat` only mints the invocation uuid, so the test must open `/api/agent-invocation/:uuid` (`e2e/lib/agent-socket.js`) before reading the log at all.

## What gates the verdict vs what is reported

B1 gates the verdict on product behavior. For each runnable skill, it enables the skill in `ws-alpha`, sends the prompt once, and requires the skill to be attached. If the model calls the tool, B1 also requires the expected content or side effect. No model-call retry occurs in B1. A and C remain strict gates, and the four unrunnable B cases remain documented skips.

The same rule applies outside the skill matrix: no gating assertion may depend on the model choosing to call a tool. The `30-security` path-traversal case asserts that the canary content never comes back and, *if* the model called the read tool, that the denial is what it got — the guard itself is proven deterministically in `server/__tests__/utils/agents/filesystemPathTraversal.test.js`, which calls `validatePath` directly against a file that really exists outside the root.

B2 reports model tool invocation separately. For each runnable skill, it retries up to three attempts until the model calls a tool, then checks the expected content or side effect. A B2 failure is recorded in `e2e/.state/model-nocall.json` instead of failing Jest. `e2e/run.sh` prints `MODEL_NOCALL=<n> skills=<comma list>` before `E2E_RESULT`; this metric does not affect the verdict.

## Negative controls

These temporary mutations must make the suite red and must be reverted immediately after verification:

1. Make `agentSkillsForWorkspace` return every canonical plugin key. Expected red output: 43 failures across `10-skills` A/C and `20-isolation` case 1 (the ledger records 43 for the B1/B2 split; treat a materially lower count as the control not biting).
2. Allow managers through the GET agent-skills route guard. Expected red output: `30-security` case 1 fails.
3. Point Vite at `VITE_API_BASE=http://localhost:3999/api`. Expected red output: Playwright UI test 1 fails within 60 seconds rather than hanging.

These four verify that the positive controls above actually bite — each one previously left the affected test green:

4. Drop the `@agent` prefix from `agentChatV1` in `e2e/lib/api.js`, so no agent cluster ever starts. Expected red output: all 13 `10-skills` A cases and all 13 C cases fail on the `AGENT_RAN` assertion.
5. Enable `sql-agent` in `ws-alpha` as well as `ws-beta` in `30-security` case "skill enabled in beta does not attach in alpha". Expected red output: that test fails on `attached(chunk, "sql-agent")`.
6. Make `#isPathWithinAllowedDirectories` in `server/utils/agents/aibitat/plugins/filesystem/lib.js` return `true` unconditionally. Expected red output: 4 failures in `server/__tests__/utils/agents/filesystemPathTraversal.test.js` (run with the root `jest`, not the E2E config). The `30-security` traversal case also goes red when the model happens to call the read tool, but it does not gate on that call — see below.
7. Append a line containing `e2epass` to `e2e/logs/server-A.log`. Expected red output: the `server A log does not leak credentials` case fails while the `server B` case still passes.
