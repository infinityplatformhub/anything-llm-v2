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

## Test contract

`/v1` developer API keys are instance-global by design. They are admin-equivalent credentials, not workspace-membership credentials. Membership isolation uses JWT workspace routes instead.

`test.todo` cases are phase markers for behavior not implemented yet. Intentional skips live in `e2e/SKIPS.md`, one ` :: ` record per pending Jest test. `e2e/run.sh` compares that record count with Jest `numPendingTests`; any undocumented or stale skip makes the final verdict fail.

## What gates the verdict vs what is reported

B1 gates the verdict on product behavior. For each runnable skill, it enables the skill in `ws-alpha`, sends the prompt once, and requires the skill to be attached. If the model calls the tool, B1 also requires the expected content or side effect. No model-call retry occurs in B1. A and C remain strict gates, and the four unrunnable B cases remain documented skips.

B2 reports model tool invocation separately. For each runnable skill, it retries up to three attempts until the model calls a tool, then checks the expected content or side effect. A B2 failure is recorded in `e2e/.state/model-nocall.json` instead of failing Jest. `e2e/run.sh` prints `MODEL_NOCALL=<n> skills=<comma list>` before `E2E_RESULT`; this metric does not affect the verdict.

## Negative controls

These temporary mutations must make the suite red and must be reverted immediately after verification:

1. Make `agentSkillsForWorkspace` return every canonical plugin key. Expected red output: at least 27 failures across `10-skills` A/C and `20-isolation` case 1.
2. Allow managers through the GET agent-skills route guard. Expected red output: `30-security` case 1 fails.
3. Point Vite at `VITE_API_BASE=http://localhost:3999/api`. Expected red output: Playwright UI test 1 fails within 60 seconds rather than hanging.
