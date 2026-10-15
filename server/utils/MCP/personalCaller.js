const prisma = require("../prisma");
const { decodeJWT } = require("../http");
const { ROLES } = require("../middleware/multiUserProtected");
const verified = new WeakSet();
const sessions = new WeakMap();

async function activeMember(userId, workspace) {
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(workspace?.id)
  )
    throw new Error("personal_auth_required");
  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user || user.suspended) throw new Error("personal_auth_required");
  const accessibleWorkspace = await prisma.workspaces.findFirst({
    where: {
      id: workspace.id,
      ...(![ROLES.admin, ROLES.manager].includes(user.role) && {
        workspace_users: { some: { user_id: userId } },
      }),
    },
    select: { id: true },
  });
  if (!accessibleWorkspace) throw new Error("personal_auth_required");
  return userId;
}
function issue(userId, workspace) {
  const caller = Object.freeze({ userId, workspaceId: workspace.id });
  verified.add(caller);
  return caller;
}
async function fromResponse(response, workspace) {
  const id = response.locals?.browserSessionUserId;
  if (!id || response.locals?.user?.id !== id)
    throw new Error("personal_auth_required");
  await activeMember(id, workspace);
  return issue(id, workspace);
}
async function assert(caller, workspace) {
  if (!caller || !verified.has(caller) || caller.workspaceId !== workspace?.id)
    throw new Error("personal_auth_required");
  const token = sessions.get(caller);
  if (token && decodeJWT(token)?.id !== caller.userId)
    throw new Error("personal_auth_required");
  return activeMember(caller.userId, workspace);
}
// Used only after consuming a signed, single-use OAuth state from the database.
async function fromOAuthState(userId, workspace) {
  await activeMember(userId, workspace);
  return issue(userId, workspace);
}
async function fromSocket(request, invocation) {
  const auth = request.headers?.authorization;
  const protocols = String(request.headers?.["sec-websocket-protocol"] || "")
    .split(",")
    .map((part) => part.trim());
  const token = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : protocols
        .find((part) => part.startsWith("anythingllm-session."))
        ?.slice(20);
  const payload = token ? decodeJWT(token) : null;
  if (!payload?.id || payload.id !== invocation.user_id)
    throw new Error("personal_auth_required");
  await activeMember(payload.id, invocation.workspace);
  const identity = issue(payload.id, invocation.workspace);
  sessions.set(identity, token);
  return identity;
}
module.exports = { fromResponse, assert, fromOAuthState, fromSocket };
