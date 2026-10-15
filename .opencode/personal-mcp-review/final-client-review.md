# Task 4 — independent final scoped client review

**Disposition: CHANGES REQUESTED. Not production-ready.**

Date: 2026-10-08. Review performed directly in this permitted client worktree. No child agents, product edits, production operations, migrations, role/permission changes, or full-suite repeats. Only this review artifact was written.

## Verdicts — Spec + Quality

| Item | Axis | Verdict | Final assessment |
| --- | --- | --- | --- |
| S1 global-vs-shadow invalidation | Spec | **ADDRESSED** | Global invalidation excludes same-name workspace definitions; grant/client regression exists. Pending callbacks rely on preserved version/fingerprint, rather than an explicit shadow-callback test. |
| S2 mixed legacy/personal websocket ownership | Spec | **NOT ADDRESSED** | Legacy startup is preserved, but failed socket ownership still permits executing the creator's prompt/history/files/attachments. No sticky private-context boundary protects a later socket. |
| S3 prompt/response/log privacy | Spec | **NOT ADDRESSED** | Prompt/response placeholders improve normal storage, but first-use pre-registration can race redaction; private-derived legacy calls still reach generic traces; inner provider errors bypass the outer sanitizer. S2 also defeats socket privacy. |
| S4 verified account label | Spec | **NOT ADDRESSED** | Own-label persistence/status/rendering exists, but the client discards the supplied backend's actual `account: {actor_id, label}` token contract. |
| Q1 actual route/execution/wire tests | Quality | **NOT ADDRESSED** | Actual callbacks, execution methods and SDK wire coverage were added, but socket tests mock the essential handler and do not cover private-context reconnect, first-use races or mixed private-to-legacy execution. Browser E2E remains open. |
| Q2 separate PG migration | Quality | **NOT ADDRESSED** | Separate PG DDL + disposable execution evidence + operator plan address the new-table portion. Full PG generated-client/local startup integration is still unverified and required before release; unchanged startup still generates/migrates the SQLite-default schema. |

`NOT ADDRESSED` means the complete scoped requirement remains open, not that the partial corrections or reported passing tests are absent.

## Findings requiring action

### F1 — P1 / S2, S3, Q1: unauthorized legacy socket can execute creator-private input

**Exact paths:**

- `server/endpoints/agentWebsocket.js:74–76`: calls `AgentHandler.init()` before socket identity validation.
- `server/utils/agents/index.js:548–555,786–793`: loads an open invocation by UUID, performs provider setup, then consumes `getAndClearInvocationAttachments`.
- `server/endpoints/agentWebsocket.js:97–108,160–164`: owner validation failure sets `mcpCaller = null`, but still creates AIbitat and starts the cluster.
- `server/utils/agents/index.js:82–121,863–880`: loads the invocation creator's `include:true` history, not the socket viewer's history.
- `server/utils/agents/index.js:801–818,844–854`: parsed-file context uses invocation creator/thread and pinned documents; no socket identity check.
- `server/utils/agents/index.js:925–934,965–971`: binds the supplied socket, then starts with the creator's invocation prompt and cached attachments.
- `server/utils/agents/aibitat/plugins/websocket.js:156–173,415–420`: introspection, stream send and agent messages send directly to that socket without a private-context/owner guard.
- `server/utils/chats/agents.js:56–61,81–92`; `server/models/workspaceAgentInvocation.js:30–39`: an HTTP follow-up creates a new UUID with its original prompt persisted and attachments cached. A prompt quoting an earlier private reply is not redacted here.

**Concrete reproduction:** owner has used a personal tool; an HTTP follow-up says `@agent <quoted private result>` (or attaches private content). An anonymous/other-member socket connects to that new open owner UUID before the owner, or another socket connects while the invocation remains open. Owner validation fails; personal tools are absent, but legacy/model execution still receives the quoted private prompt and cached attachments and returns content to the unauthorized socket. The first socket also removes the attachment cache entry before authorization.

**Fresh bounded probe:** loaded the actual endpoint, actual `AgentHandler.init/createAIbitat/startAgentCluster`, and actual websocket plugin in a Node VM; stubbed DB, AI/provider/default definitions only, with synthetic fixture content and no external I/O. Owner validation deliberately rejected. Observed:

```json
{"ownerValidation":"rejected","cachedAttachmentsConsumedBeforeValidation":1,"historyFilter":{"workspaceId":11,"user_id":7,"thread_id":null,"api_session_id":null,"include":true},"unauthorizedSocketContent":"fixture-quoted-private-owner-result fixture-private-owner-attachment"}
```

**Important boundary:** a fresh route creates a new handler (`agentWebsocket.js:74`), and `createAIbitat` creates a new AIbitat (`agents/index.js:869`). There is no demonstrated reuse of the old private in-memory handler by this route. Previously redacted personal chat rows are excluded by `include:true`; this finding does **not** claim those placeholder rows restore old tool results. The real exposure is owner input/context loaded afresh, including private-result quotations and cached attachments. A separate actual-plugin probe also showed that attaching the websocket plugin to already-private context sends the result even with `mcpCaller:null`, but that probe alone does not establish a live-handler reattachment route.

**Scoped correction:** retain compatibility for genuinely legacy-only invocations, but introduce a trusted owner/private-context boundary that survives personal use and follows its thread/follow-up invocations. Reject unauthorized sockets for that context **before** provider setup, attachment consumption, history/files loading or any socket emission. Mark the boundary no later than first personal tool exposure, not just handler completion; removing/disconnecting the current personal definition must not remove protection for prior private context. Do not rely on disabling new personal discovery to sanitize an already-private prompt. Add actual-handler regressions for owner, other member and anonymous reconnect/follow-up, including definition removal and cached attachments. No broad legacy websocket redesign is requested.

### F2 — P2 / S3, Q1: sticky privacy does not protect private-to-legacy trace output

**Paths:** `server/utils/agents/aibitat/index.js:1080–1098,1259–1266`; `server/utils/MCP/index.js:107–109,241–247,256–259`.

The generic trace suppression condition is only `fn.privateMcp`. After a private read, the model can pass the private result as an argument to an ordinary/legacy tool. That next function is not marked private; its args/result are emitted via `toolCallResult` despite `personalMcpUsed` being sticky. Streaming verbose introspection also includes those copied args. The handler log wrapper (`agents/index.js:874–877`) suppresses some console logging but does not suppress the emitter or direct introspection.

**Fresh probe:** actual `AIbitat.handleExecution` and `handleAsyncExecution`, with dependency/provider fixtures, executed personal-read → legacy-consume → final reply. Both emitted one generic `toolCallResult` containing `fixture-private-owner-result` in arguments and result. No remote call or product edit.

**Scoped correction:** enforce private-context suppression at generic trace/diagnostic boundaries for subsequent tools too; test both execution methods with private → legacy transitions. This is not a request to prohibit legitimate owner tool use or change legacy authorization.

### F3 — P2 / S3, Q1: first-use prompt redaction races asynchronous chat registration

**Paths:** `server/utils/agents/aibitat/index.js:499–506,584–590`; `server/utils/agents/aibitat/plugins/chat-history.js:23–60,64–66`; `server/utils/MCP/index.js:107–128`.

`newMessage` emits through an ordinary EventEmitter without awaiting the async pre-registration listener. The listener captures the original prompt and awaits `WorkspaceChats.new`; `trackedChatId` is set only afterward. A fast first personal handler can set the privacy marker while `trackedChatId` is still null, skipping its one-time redaction. An abort before final `_storePersonal` leaves the original private prompt in the row. `include:false` is a retrieval flag, not redaction.

**Fresh ordering probe:** actual chat-history setup with a deferred fixture `WorkspaceChats.new`: began first input, set personal-use marker while no ID existed, then aborted and resolved registration. The captured stored prompt remained `fixture-private-first-input`. Existing abort test starts with `personalMcpUsed:true` and does not cover this first-use ordering (`server/__tests__/utils/MCP/personalPrivacy.test.js:36–56`).

**Scoped correction:** synchronize registration/redaction or recheck the sticky marker immediately after the awaited row creation and redact even on abort. Add deferred-create/first-private-call/abort coverage; normal response placeholders alone are insufficient.

### F4 — P2 / S3, Q1: provider-internal console error bypasses privacy guard

**Paths:** `server/utils/agents/aibitat/providers/ai-provider.js:148–154`; `server/utils/agents/aibitat/index.js:994–1005`; `server/utils/agents/aibitat/providers/genericOpenAi.js:111–151` (especially `:142`).

The new `providerLog` and outer `#safeProviderCall` guards do not intercept direct `console.error(error.message, error)` inside a provider. Generic OpenAI streaming logs the raw exception before rethrowing into the sanitized AIbitat boundary. This is an unchanged file inspected for the named provider-log privacy risk, not an unrelated provider refactor request.

**Fresh probe:** actual `GenericOpenAiProvider.stream`, fixture tooled-stream throwing `fixture-private-result-echo`, `invocation.personalMcpUsed:true`: direct console output captured that exact private echo. Initial probe fixture omitted `maxTokensKey`; corrected fixture then reproduced the intended provider exception. No live model call.

**Scoped correction:** guard/bound provider error logging for private context before any raw exception is emitted. Test an actual provider wrapper, not just a fake provider rejected at the outer boundary. Other similar direct catches need the same narrow privacy audit; no claim that every provider has been dynamically verified.

### F5 — P2 / S4: actual provider account contract is discarded

**Paths:** `server/utils/MCP/oauth.js:239–263` (especially `:256–258`); `server/models/personalMcpGrant.js:73–85,111–119`; `server/endpoints/mcpOAuth.js:398–415`; `frontend/src/components/WorkspaceChat/ChatContainer/PersonalMcpConnections.jsx:68–70`; `docs/plans/personal-mcp-client-report.md:44,123,142`.

Backend contract supplied for this review: token response contains `account: {actor_id, label}`; provider currently emits that nested object. The client only copies top-level `data.account_label`. It discards `account` before the grant model can persist its label; own status returns null and UI omits identity. The report incorrectly frames this as the provider needing to emit `account_label`. Sanitization/rendering exists, but is unreachable for the actual provider contract.

**Fresh probe:** actual `oauth.refreshTokens`/token parser with fixture discovery and token response `{access_token,refresh_token,expires_in,account:{actor_id:'fixture-actor',label:'Verified Fixture Shop'}}`: returned neither `account_label` nor `account`. This confirms a contract mismatch, not merely absent test evidence. Backend implementation was not accessed outside this repo; nested shape is controller/user-supplied contract evidence.

**Scoped correction:** explicitly validate and normalize the verified token endpoint's nested public label into the existing bounded internal label contract (and retain only approved public fields). Never infer identity from a prompt/request, fabricate an actor, decode raw JWTs for display, or persist the entire arbitrary token response. Add exchange + refresh → grant → own status tests using the actual nested shape, and correct the report. No provider-role or shared-key change.

## S1 evidence: global invalidation is now scoped

`server/utils/MCP/hypervisor/index.js:82–95,116–148` enumerates workspace-owned shadows, gathers affected grant/client/boot workspaces, skips shadow IDs, and invalidates/stops only the remaining workspaces. `server/utils/MCP/index.js:410–411` uses that method on global removal. Workspace changes stay explicitly workspace-scoped (`server/endpoints/workspaceMcpServers.js:257–266,278–285`).

`server/__tests__/utils/MCP/personalRuntime.test.js:120–152` covers a global consumer and a same-name workspace shadow, enabled shadow grant and no client closure. It calls the invalidation method directly rather than a real delete endpoint and does not explicitly execute a shadow callback. Callback version/fingerprint checks (`server/endpoints/mcpOAuth.js:183–200,215–230`) explain why preserved shadow rows keep their pending flow usable. No remaining S1 defect established by this bounded review.

## personalCaller identity validity — beyond nominal helpers

- `server/utils/MCP/personalCaller.js:5–18,20–36,42–56`: positive integer user, current active user + membership, frozen WeakSet-issued capability, workspace binding, signed socket JWT owner equality. Request/query user IDs and fabricated caller objects are rejected.
- `server/utils/http/index.js:60–65`: uses `JWT.verify`, not unsigned decoding; `server/utils/middleware/validatedRequest.js:85–110` issues the HTTP marker only after current user/suspension validation. Browser session issuer uses `{id,username}` (`server/endpoints/system.js:328–331`). No evidence here of an API key becoming a browser session.
- `server/utils/MCP/index.js:80–83,135–136`: plugin captures the capability at construction; dispatch passes that same object. `server/utils/MCP/personalRuntime.js:17–29,31–33,151–159,170–181`: discovery/call rechecks caller membership/config/grant. A newly forged capability cannot replace it.
- Fresh VM probe: fabricated capability rejected, new invalid/expired socket identity rejected, suspension rejected. An **already-issued** capability remains valid after the fixture session validator starts rejecting that token: `assert` checks membership but retains no JWT expiry/session handle. This is a lifetime limitation, not proof of a forged-JWT bypass or expired initial handshake. Document/test the intended lifetime and bind output authorization to the actual socket/private invocation boundary, not merely this reusable user capability.
- The proven owner-context disclosure in F1 occurs even when `fromSocket` correctly rejects identity. Correct helper validation therefore does not establish socket result isolation after first personal exposure.

## Q1 evidence and remaining coverage

Actual route callbacks are exercised in `server/__tests__/endpoints/personalMcpSocket.test.js:51–112`, but `AgentHandler` is mocked (`:11,62–77`); personal/legacy behavior is manufactured with `if (handler.invocation.mcpCaller)`, and no sent-content/private follow-up assertion exists. OAuth callback tests skip the browser validator and seed response locals (`server/__tests__/endpoints/personalMcpOAuth.test.js:108–159`); these are not complete HTTP/browser auth pipelines.

`server/__tests__/utils/MCP/personalExecution.test.js:24–72` executes real streaming/non-streaming methods but covers only a directly private function followed by safe final text, not private-derived legacy calls or an actual provider catch. `server/__tests__/e2e/mcp/personal.e2e.test.js:125–190` covers real OAuth HTTP/Prisma/SDK A/B account isolation, refresh/disconnect; `:192–275` covers actual HTTP 401/503 after mutation with counters exactly one. This **does** address SDK wire-level no-replay evidence. It is not browser E2E (`:82–109` manually invokes registered client route handlers).

Required focused additions: actual-handler private-context follow-up/socket output denial before init side effects; revoked/expired owner boundary after exposure; first-use registration race; private → legacy traces; provider-internal exception privacy; nested account wire shape. Existing green suites do not contradict these uncovered paths.

## Q2 evidence: separate DDL present, full PG startup release gate open

- `server/prisma/postgresql/personal-mcp-grants.sql:1–20`: standalone additive PG transaction, SERIAL/TIMESTAMP, unique workspace/user/server key, indexes/FK cascades. No legacy credential copy or SQLite history replay.
- `server/prisma/migrations/20261008000000_personal_mcp_grants/migration.sql:1–19`: separate SQLite new-table migration; old migrations were not rewritten in the supplied diff.
- `server/__tests__/utils/MCP/personalPostgresql.test.js:6–83`: destination guard for authorized localhost disposable DB, isolated schema, actual DDL, scope/CAS/cascade checks, rollback. This is raw PG SQL against minimal users/workspaces, **not** the full generated Prisma client/application/startup.
- Local retained evidence: `server/storage/personal-mcp-test-evidence/personal-final-review-gates.log:9,19–20` reports PG plus socket/privacy 3 suites / 10 tests passing; `personal-server-suite.log:2372,2588–2589` reports PG in server 107 suites / 1,514 tests. Review did not connect to PG or repeat these runs.
- `server/prisma/schema.prisma:1–16` remains SQLite-default; `docker/docker-entrypoint.sh:19–25` still generates then runs `prisma migrate deploy` from that schema. Inspected this unchanged file specifically to verify the reported migration wiring risk, not to modify deployment.
- `docs/plans/personal-mcp-client-report.md:107–117,124` gives an operator-owned PG artifact/startup override/migration plan and explicitly says it was not executed. Full PG generated-client + local application startup path must be verified before release. The plan is not evidence that gate passed.

## Verification accounting and scope limits

Read all six requested documents, including all 3,821 lines of `final-client-review.diff`; line references above are **current worktree file lines**, not diff-display offsets. Additional reads stayed in this repo and were motivated by named identity, owner-context, trace/provider-log, history race and PG-startup risks. Independent probes used actual source in an in-memory VM with synthetic fixture users/content/dependencies, no database writes, external network, test artifact files or product changes. They are focused evidence, not full app/browser E2E.

Retained/reported gates, **not fresh review reruns**:

- Server 107 suites / **1,514 PASS**: `personal-server-suite.log:2588–2589`; report `:148`.
- SDK MCP E2E 2 suites / **21 PASS**: `server/storage/personal-mcp-test-evidence/personal-e2e.log:11–12`; report `:150`.
- Frontend build: retained `personal-frontend-build.log:275` (`built in 49.57s`); build/lint exits reported in `docs/plans/personal-mcp-evidence.md:30–37`, report `:153–155`. Not browser E2E.
- Root 109 passing suites / 1,535 passing collected tests, **7 collector load failures**: `personal-full-suite.log:2859–2860`; dependency causes in report `:80–90`. Known unrelated failures; no dependency work or repeat requested.
- Controller independently reports **6 personal suites / 36 PASS** and actual SDK E2E **2 suites / 21 PASS**, with `T/opencode/redball-parent-client-tests.log` and `T/opencode/redball-parent-client-e2e.log`. Recorded as supplied evidence only; not read through external paths in this review.

Open release gates remain: full local PG generated-client/application/startup verification; browser A/B OAuth/member UX and proxy websocket handshake; real approved backend resource/contract integration. Controller's separate read-only RBAC audit also reports stock Medusa flag + plain migrate auto-assigning wildcard SuperAdmin to every admin; human role-assignment gate unresolved, no production activation planned. This review neither re-audits that external backend nor authorizes activation, migration, new/default roles or permissions.

**Next action:** address F1–F5 with narrowly targeted regressions, reconcile nested account contract, and retain the PG/browser/human role gates. Passing local SDK/server tests are useful evidence, not production readiness.
