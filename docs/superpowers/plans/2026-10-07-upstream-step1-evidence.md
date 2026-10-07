# Selective upstream step 1: correctness fixes

## Approved scope

Base: `795029874c1b0d9646030f0f6060adb349fa43a7`.
Four bounded backports; no upstream merge, version bump, schema change,
dependency update, commit, push, or deployment.

| Fix | Upstream source | Implementation |
| --- | --- | --- |
| Skip scheduled job boot/enqueue in multi-user mode | `3c7e73b8` (#6656) | `server/utils/BackgroundWorkers/index.js` |
| Isolate attachment state/listeners by workspace/thread; suppress late events | `42832eb8` (#6635) | `frontend/src/components/WorkspaceChat/ChatContainer/DnDWrapper/index.jsx` |
| Forward Generic OpenAI output budgets across native/fallback agent paths; omit zero and respect configured field name | `effcf539` (#6331), `58ae6fee` (#6470) | Generic OpenAI chat/agent providers and shared `tooled.js` |
| Read Anthropic replies from text blocks, not the first block | `128a0157` (#6496) | `server/utils/AiProviders/anthropic/index.js` |

Scheduled timers from single-user mode are removed when their next enqueue
observes multi-user mode, matching upstream. This does not introduce an immediate
global cancellation hook or a new worker lifecycle policy.

## Regression evidence

Four new test files:

- `server/__tests__/utils/BackgroundWorkers/multiUserScheduling.test.js`
- `server/__tests__/utils/AiProviders/genericOpenAi/tokenBudget.test.js`
- `server/__tests__/utils/AiProviders/anthropic/textBlocks.test.js`
- `server/__tests__/frontend/attachmentConversation.test.js`

Before implementation, the initial tests reproduced failures for all four fix
groups: scheduled timers/run claims in multi-user mode, retained attachment state
and stale workspace listeners/events, missing/zero/wrong-field token budgets,
and missing/truncated Anthropic text replies. The React attachment tests mount
the actual JSX component in JSDOM, replacing network and modal boundaries.
They cover navigation during context lookup, file parsing, modal deletion, and
modal embedding, as well as same-conversation rerenders.

After implementation:

- **40/40 new regression tests passed** in four suites.
- **91/91 suites, 1,445/1,445 tests passed**: explicitly selected tracked
  `server/__tests__/**/*.test.js` files excluding E2E, plus the four new files.
  Includes Lark, MCP, browser companion, agent, chat, and memory regressions.
- **Frontend production build passed**, including postbuild. Vite still reports
  its large-chunk warning.
- `git diff --check` passed.

Environment: Node `18.20.8`, Jest, serial execution. The wider suite requires
`--experimental-vm-modules` because the MCP SDK's `pkce-challenge` dependency
performs a dynamic import. Tests were selected by explicit paths to avoid
collecting `.claude` worktrees or treating existing helper files as tests.

## Limitations

- Standard ESLint is blocked by the existing React plugin / ESLint 9
  incompatibility: `TypeError: context.getFirstTokens is not a function`.
  Reproduced against the unchanged Generic OpenAI agent file from HEAD using
  `git show HEAD:... | eslint --stdin --stdin-filename ...`. No lint dependency
  or configuration was changed as part of these backports.
- Independent reviewer dispatch failed with `Subagent session not found: ses_`.
  The implementation diff was inspected directly against upstream patches;
  this is not an independent review.
- No new live HTTP/browser smoke tests or deployment were performed.
- This completes only the approved four-group subset, not full upstream 1.17.0
  parity. Prior enabled-memory HTTP test coverage remains pending separately.

Local verification logs (temporary, not committed):

- `upstream-step1-red.log`
- `upstream-step1-scoped-vm-suite.log`
- `upstream-step1-build.log`
- `upstream-step1-lint.log`

These reside under the approved OpenCode temporary directory.

## Pre-release review and authorization

The user subsequently authorized commit, push, deployment to the existing
BytePlus VKE instance, and live testing. The original implementation scope
above remains unchanged; unrelated local files are excluded from the release.

Direct review against the five source commits found no actionable correctness
or scope findings. Independent reviewer dispatch remains unavailable.
Fresh verification repeated 91 suites / 1,445 tests and the frontend production
build/postbuild successfully. Prettier and `git diff --check` passed.
Scoped ESLint using the server/frontend configurations passed for the six
implementation files. The root configuration still crashes at
`react/display-name` on both worktree and unchanged HEAD code.

Additional temporary review logs: `upstream-step1-review-suite.log`,
`upstream-step1-review-build.log`, `upstream-step1-review-scoped-lint.log`,
and `upstream-step1-review-root-lint.log`.
