const prisma = require("../utils/prisma");
const { v4: uuidv4 } = require("uuid");

const WorkspaceAgentInvocation = {
  // returns array of strings with their @ handle.
  // must start with @agent for now.
  parseAgents: function (promptString) {
    if (!promptString.startsWith("@agent")) return [];
    return promptString.split(/\s+/).filter((v) => v.startsWith("@"));
  },

  close: async function (uuid) {
    if (!uuid) return;
    try {
      // No row needs to be returned. updateMany writes directly instead of
      // reading first and upgrading a SQLite transaction's read lock to write.
      // The condition also makes repeated/disconnected closes idempotent.
      await prisma.workspace_agent_invocations.updateMany({
        where: { uuid: String(uuid), closed: false },
        data: { closed: true },
      });
    } catch (error) {
      console.error(
        "[WorkspaceAgentInvocation] Failed to persist closure:",
        error.code || "unknown"
      );
    }
  },

  new: async function ({
    prompt,
    workspace,
    user = null,
    thread = null,
    browserDevice = false,
  }) {
    try {
      const { PersonalMcpContext } = require("./personalMcpContext");
      if (browserDevice) {
        const encrypted =
          new (require("../utils/EncryptionManager").EncryptionManager)().encrypt(
            String(prompt)
          );
        if (!encrypted) throw new Error("android_context_unavailable");
        prompt = `android-browser-encrypted:${encrypted}`;
      } else if (
        await PersonalMcpContext.has({
          workspace_id: workspace.id,
          user_id: user?.id,
          thread_id: thread?.id,
        })
      ) {
        const encrypted =
          new (require("../utils/EncryptionManager").EncryptionManager)().encrypt(
            String(prompt)
          );
        if (!encrypted) throw new Error("personal_context_unavailable");
        prompt = `personal-mcp-encrypted:${encrypted}`;
      }
      let invocation = await prisma.workspace_agent_invocations.create({
        data: {
          uuid: uuidv4(),
          workspace_id: workspace.id,
          prompt: String(prompt),
          user_id: user?.id,
          thread_id: thread?.id,
        },
      });
      // A first private transition may have committed during the awaited insert.
      // Serialize with mark(), recheck and encrypt before exposing this UUID.
      invocation = await PersonalMcpContext.protectCreated(invocation);

      return { invocation, message: null };
    } catch (error) {
      console.error(error.message);
      return { invocation: null, message: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const invocation = await prisma.workspace_agent_invocations.findFirst({
        where: clause,
      });

      return invocation || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  getWithWorkspace: async function (clause = {}) {
    try {
      const invocation = await prisma.workspace_agent_invocations.findFirst({
        where: clause,
        include: {
          workspace: true,
        },
      });

      return invocation || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_agent_invocations.delete({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const results = await prisma.workspace_agent_invocations.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
};

module.exports = { WorkspaceAgentInvocation };
