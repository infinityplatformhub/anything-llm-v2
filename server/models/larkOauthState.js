const prisma = require("../utils/prisma");

const MODES = ["login", "connect"];

function withoutVerifier(record) {
  if (!record) return null;
  const { code_verifier: _codeVerifier, ...safeRecord } = record;
  return safeRecord;
}

const LarkOauthState = {
  tablename: "lark_oauth_states",
  writable: [],

  create: async function ({
    state,
    code_verifier,
    mode,
    user_id = null,
    expiresAt,
  }) {
    if (!MODES.includes(mode))
      return {
        oauthState: null,
        error: `Unsupported Lark OAuth mode: ${mode}`,
      };

    // Abandoned flows leave a row holding an encrypted verifier that consume()
    // never reaches. Sweeping here bounds the table without a scheduled job;
    // a failed sweep must never block a login, so it is swallowed.
    try {
      await prisma.lark_oauth_states.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (error) {
      console.error("LarkOauthState.sweep", error.message);
    }

    try {
      const oauthState = await prisma.lark_oauth_states.create({
        data: {
          state,
          code_verifier,
          mode,
          user_id: user_id === null ? null : Number(user_id),
          expiresAt,
        },
      });
      return { oauthState: withoutVerifier(oauthState), error: null };
    } catch (error) {
      console.error("LarkOauthState.create", error.message);
      return { oauthState: null, error: error.message };
    }
  },

  consume: async function (state, { withSecrets = false } = {}) {
    try {
      return await prisma.$transaction(async (tx) => {
        const oauthState = await tx.lark_oauth_states.findUnique({
          where: { state },
        });
        if (!oauthState) return null;

        const now = new Date();
        if (oauthState.expiresAt <= now) {
          await tx.lark_oauth_states.delete({ where: { state } });
          return null;
        }

        const { count } = await tx.lark_oauth_states.deleteMany({
          where: { state, expiresAt: { gt: now } },
        });
        if (count !== 1) return null;
        return withSecrets ? oauthState : withoutVerifier(oauthState);
      });
    } catch (error) {
      console.error("LarkOauthState.consume", error.message);
      return null;
    }
  },
};

module.exports = { LarkOauthState };
