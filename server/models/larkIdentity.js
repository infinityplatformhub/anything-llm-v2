const prisma = require("../utils/prisma");

const SECRET_FIELDS = ["access_token", "refresh_token"];
const IDENTITY_FIELDS = [
  "open_id",
  "union_id",
  "tenant_key",
  "email",
  "display_name",
  "avatar_url",
  "access_token",
  "refresh_token",
  "access_expires_at",
  "refresh_expires_at",
  "scopes",
  "needs_reauth",
];
const TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "access_expires_at",
  "refresh_expires_at",
  "scopes",
  "needs_reauth",
];

function withoutSecrets(record) {
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !SECRET_FIELDS.includes(key))
  );
}

function pick(data, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => data[field] !== undefined)
      .map((field) => [field, data[field]])
  );
}

function withNumericIds(where = {}) {
  const parsed = { ...where };
  for (const field of ["id", "user_id"])
    if (parsed[field] !== undefined) parsed[field] = Number(parsed[field]);
  return parsed;
}

const LarkIdentity = {
  tablename: "lark_identities",
  writable: [],

  get: async function (where = {}, { withSecrets = false } = {}) {
    try {
      const identity = await prisma.lark_identities.findFirst({
        where: withNumericIds(where),
      });
      return withSecrets ? identity : withoutSecrets(identity);
    } catch (error) {
      console.error("LarkIdentity.get", error.message);
      return null;
    }
  },

  upsertForUser: async function (data) {
    try {
      const user_id = Number(data.user_id);
      const create = { ...pick(data, IDENTITY_FIELDS), user_id };
      const update = {
        ...pick(data, IDENTITY_FIELDS),
        lastUpdatedAt: new Date(),
      };
      const identity = await prisma.lark_identities.upsert({
        where: { user_id },
        create,
        update,
      });
      return { identity: withoutSecrets(identity), error: null };
    } catch (error) {
      console.error("LarkIdentity.upsertForUser", error.message);
      return { identity: null, error: error.message };
    }
  },

  updateTokens: async function (id, tokens) {
    try {
      const identity = await prisma.lark_identities.update({
        where: { id: Number(id) },
        data: { ...pick(tokens, TOKEN_FIELDS), lastUpdatedAt: new Date() },
      });
      return { identity: withoutSecrets(identity), error: null };
    } catch (error) {
      console.error("LarkIdentity.updateTokens", error.message);
      return { identity: null, error: error.message };
    }
  },

  delete: async function (where = {}) {
    try {
      await prisma.lark_identities.deleteMany({
        where: withNumericIds(where),
      });
      return true;
    } catch (error) {
      console.error("LarkIdentity.delete", error.message);
      return false;
    }
  },
};

module.exports = { LarkIdentity };
