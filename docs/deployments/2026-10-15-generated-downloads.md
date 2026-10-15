# Generated file download hotfix

## Running release

- Source fix: `31d10746b30e2b2adf9b942efc0be7fb97a4a8ec`.
- Namespace/deployment/container: `anythingllm/anythingllm/anythingllm`.
- Registry: `infinityplatform-ap-southeast-1.cr.bytepluses.com/infi/anythingllm-v2`.
- Deployed tag: `download-fix-31d10746-r2`.
- Deployed digest: `sha256:1e0a3a81bd4b12ef0e44317406837f77d64c1244a3911a97eeca0777a337b13a`.
- Original runtime base: `sha256:54cb5b570137acfdec4d1dd867d3f52258875f98dc6191d5d804dd46fa87ab00`.

The release inherits the original runtime and frontend from that immutable base.
It overlays only `lib.js` and the XLSX, DOCX, PDF, PPTX and text handlers under
`server/utils/agents/aibitat/plugins/create-files/`. References are persisted
before publishing live download cards, allowing immediate authorized downloads.

## Frontend compatibility incident

The first hotfix also replaced the frontend with a build from this checkout.
That frontend predates the running backend's private conversation authentication:
it opens agent WebSockets without the `anythingllm-session.<JWT>` subprotocol.
The production backend rejects that connection for a private conversation. The
old close handler then displays `Agent session complete.` without a model reply.

The first digest, `sha256:6130ad9a607af049cd490daa27917a085ef184ecbc4104eec1322dea22d26c4e`,
is superseded. R2 restores the original frontend while retaining the download
backend fix. The new frontend error messages in source commit `31d10746` are
therefore not deployed.

Before replacing this frontend again, reconcile the production frontend source
and its authentication protocol, and pass a real browser chat test in a private
conversation. A login-page check and a file download API test alone do not cover
this path. Never log JWTs or WebSocket authentication headers.

## Verification

- Six patched backend file checksums match the source fix.
- Public frontend `index.js` matches the original production file, SHA-256
  `c3134d27ab8f616e3154015b942c72c40374a081039c3fed6a2f9679d521a372`.
- Chromium sent two messages in a temporary private conversation; both reached
  the real model and rendered their expected answers without script errors.
- Live API downloaded a readable two-sheet XLSX before final chat persistence;
  historical download, authentication and workspace denial checks passed.
- Temporary users, workspaces, privacy markers, invocations and files were removed.
- Deployment configuration changes are limited to the application image.
- `kube.yml` is excluded by Git and Docker ignore rules; no credentials were
  committed or included in the build contexts.
