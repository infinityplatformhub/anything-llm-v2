const prisma = require("../utils/prisma");
async function lock(tx, workspaceId) {
  // Portable SQLite/PG first-write lock. PG locks this workspace row; SQLite
  // obtains its write lock before reading privacy state. No field is changed.
  await tx.$executeRaw`UPDATE workspaces SET "lastUpdatedAt" = "lastUpdatedAt" WHERE id = ${workspaceId}`;
}
function encryptedPrompt(prompt) {
  if (
    prompt.startsWith("personal-mcp-encrypted:") ||
    prompt.startsWith("android-browser-encrypted:")
  )
    return prompt;
  const encrypted =
    new (require("../utils/EncryptionManager").EncryptionManager)().encrypt(
      prompt
    );
  if (!encrypted) throw new Error("personal_context_unavailable");
  return `personal-mcp-encrypted:${encrypted}`;
}
function scope(invocation) {
  if (
    !Number.isInteger(invocation?.workspace_id) ||
    !Number.isInteger(invocation?.user_id)
  )
    return null;
  return {
    workspace_id: invocation.workspace_id,
    user_id: invocation.user_id,
    thread_key: invocation.thread_id ?? 0,
  };
}
const PersonalMcpContext = {
  async prepare(invocation) {
    try {
      await this.prepareStrict(invocation);
    } catch {
      // Unknown is not evidence of deletion/disconnection. Do not expose lookup
      // errors or private configuration, and never proceed to legacy init.
      throw new Error("personal_context_unavailable");
    }
  },
  async prepareStrict(invocation) {
    if (!scope(invocation) || (await this.has(invocation))) return;
    // Classify the persisted creator's current connected capability, never the
    // socket viewer, request userId, catalog existence or a remote boot result.
    const { PersonalMcpGrant: Grant } = require("./personalMcpGrant");
    const rows = await prisma.personal_mcp_grants.findMany({
      where: {
        workspace_id: invocation.workspace_id,
        user_id: invocation.user_id,
        enabled: true,
      },
      select: { server_name: true },
    });
    if (!rows.length) return;
    const MCP = require("../utils/MCP");
    for (const { server_name: name } of rows) {
      const config = (
        await MCP.findServerConfigStrict(name, invocation.workspace_id)
      )?.server;
      if (config?.anythingllm?.perUserAuth !== true) continue;
      require("../utils/MCP/serverConfig").validateWorkspaceServerConfig(
        config
      );
      const grant = await Grant.find(
        invocation.workspace_id,
        invocation.user_id,
        name,
        config
      );
      if (!grant?.enabled) continue;
      if (typeof grant.access_token !== "string" || !grant.access_token)
        throw new Error("personal_grant_unavailable");
      await this.mark(invocation);
      return;
    }
  },
  async protectCreated(invocation) {
    const owner = scope(invocation);
    if (!owner) return invocation;
    return prisma.$transaction(async (tx) => {
      await lock(tx, owner.workspace_id);
      const marked = await tx.personal_mcp_contexts.findUnique({
        where: { workspace_id_user_id_thread_key: owner },
      });
      if (!marked) return invocation;
      const prompt = encryptedPrompt(invocation.prompt);
      await tx.workspace_agent_invocations.updateMany({
        where: {
          uuid: invocation.uuid,
          workspace_id: owner.workspace_id,
          user_id: owner.user_id,
        },
        data: { prompt },
      });
      return { ...invocation, prompt };
    });
  },
  async has(invocation) {
    const owner = scope(invocation);
    if (!owner) return false;
    return !!(await prisma.personal_mcp_contexts.findUnique({
      where: { workspace_id_user_id_thread_key: owner },
    }));
  },
  async mark(invocation) {
    const owner = scope(invocation);
    if (!owner) throw new Error("personal_auth_required");
    await prisma.$transaction(async (tx) => {
      await lock(tx, owner.workspace_id);
      await tx.personal_mcp_contexts.upsert({
        where: { workspace_id_user_id_thread_key: owner },
        create: owner,
        update: {},
      });
      const rows = await tx.workspace_agent_invocations.findMany({
        where: {
          workspace_id: owner.workspace_id,
          user_id: owner.user_id,
          thread_id: invocation.thread_id ?? null,
        },
        select: { id: true, prompt: true },
      });
      for (const row of rows) {
        if (row.prompt.startsWith("personal-mcp-encrypted:")) continue;
        await tx.workspace_agent_invocations.update({
          where: { id: row.id },
          data: { prompt: encryptedPrompt(row.prompt) },
        });
      }
    });
    invocation.personalMcpUsed = true;
  },
};
module.exports = { PersonalMcpContext };
