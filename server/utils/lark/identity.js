const crypto = require("crypto");
const { LarkIdentity } = require("../../models/larkIdentity");
const { User } = require("../../models/user");

const MAX_USERNAME_LENGTH = 64;

function sanitizeLocalPart(email) {
  if (typeof email !== "string" || !email.includes("@")) return "";
  return email.split("@", 1)[0].toLowerCase().replace(/[^a-z0-9_.-]/g, "");
}

function isValidUsername(username) {
  return (
    username.length >= 2 &&
    username.length <= MAX_USERNAME_LENGTH &&
    User.usernameRegex.test(username)
  );
}

async function deriveUsername({ email, openId, exists }) {
  const localPart = sanitizeLocalPart(email);
  const fallback = `lark_${String(openId ?? "").slice(0, 12)}`;
  const base = isValidUsername(localPart) ? localPart : fallback;

  if (!(await exists(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${base.slice(0, MAX_USERNAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!(await exists(candidate))) return candidate;
  }
}

function identityData({ userId, userInfo, tokens, encryption }) {
  return {
    user_id: Number(userId),
    open_id: userInfo.open_id,
    union_id: userInfo.union_id,
    tenant_key: userInfo.tenant_key,
    email: userInfo.email,
    display_name: userInfo.name,
    avatar_url: userInfo.avatar_url,
    access_token: encryption.encrypt(tokens.accessToken),
    refresh_token: encryption.encrypt(tokens.refreshToken),
    access_expires_at: tokens.accessExpiresAt,
    refresh_expires_at: tokens.refreshExpiresAt,
    scopes: tokens.scopes,
    needs_reauth: false,
  };
}

function isUniqueConflict(error) {
  const message = typeof error === "string" ? error : error?.message;
  return error?.code === "P2002" || message?.includes("P2002") || message?.includes("Unique constraint");
}

async function persistIdentity(args) {
  let result;
  try {
    result = await LarkIdentity.upsertForUser(identityData(args));
  } catch (error) {
    result = { identity: null, error };
  }
  if (!result.error) return { identity: result.identity, error: null };
  if (!isUniqueConflict(result.error)) return { identity: null, error: "unknown" };

  const owner = await LarkIdentity.get({ open_id: args.userInfo.open_id });
  if (!owner) return { identity: null, error: "unknown" };
  return Number(owner.user_id) === Number(args.userId)
    ? { identity: owner, error: null }
    : { identity: null, error: "link_conflict" };
}

function tenantMatches({ config, userInfo }) {
  return Boolean(
    config?.tenantKey &&
      userInfo?.tenant_key &&
      config.tenantKey === userInfo.tenant_key
  );
}

async function connectIdentity({ userId, userInfo, tokens, config, encryption }) {
  try {
    if (!tenantMatches({ config, userInfo }))
      return { identity: null, error: "unknown" };

    const openIdentity = await LarkIdentity.get({ open_id: userInfo.open_id });
    if (openIdentity && Number(openIdentity.user_id) !== Number(userId))
      return { identity: null, error: "link_conflict" };

    const userIdentity = await LarkIdentity.get({ user_id: Number(userId) });
    if (userIdentity && userIdentity.open_id !== userInfo.open_id)
      return { identity: null, error: "link_conflict" };

    return persistIdentity({ userId, userInfo, tokens, encryption });
  } catch (_) {
    return { identity: null, error: "unknown" };
  }
}

async function resolveLoginUser({ userInfo, tokens, config, encryption }) {
  try {
    if (!tenantMatches({ config, userInfo }))
      return { user: null, identity: null, error: "unknown" };

    const linkedIdentity = await LarkIdentity.get({ open_id: userInfo.open_id });
    if (linkedIdentity) {
      const user = await User.get({ id: Number(linkedIdentity.user_id) });
      if (!user) return { user: null, identity: null, error: "unknown" };
      if (user.suspended)
        return { user: null, identity: null, error: "suspended" };

      const saved = await persistIdentity({
        userId: user.id,
        userInfo,
        tokens,
        encryption,
      });
      if (saved.error)
        return { user: null, identity: null, error: saved.error };
      return { user, identity: saved.identity, created: false, error: null };
    }

    const localPart = sanitizeLocalPart(userInfo.email);
    if (isValidUsername(localPart)) {
      const user = await User.get({ username: localPart });
      if (user) {
        if (user.suspended)
          return { user: null, identity: null, error: "suspended" };
        const saved = await persistIdentity({
          userId: user.id,
          userInfo,
          tokens,
          encryption,
        });
        if (saved.error)
          return { user: null, identity: null, error: saved.error };
        return { user, identity: saved.identity, created: false, error: null };
      }
    }

    const username = await deriveUsername({
      email: userInfo.email,
      openId: userInfo.open_id,
      exists: async (candidate) => Boolean(await User.get({ username: candidate })),
    });
    const { user, error } = await User.create({
      username,
      password: crypto.randomBytes(32).toString("hex"),
      role: "default",
    });
    if (error || !user)
      return { user: null, identity: null, error: "unknown" };

    const saved = await persistIdentity({
      userId: user.id,
      userInfo,
      tokens,
      encryption,
    });
    if (saved.error)
      return { user: null, identity: null, error: saved.error };
    return { user, identity: saved.identity, created: true, error: null };
  } catch (_) {
    return { user: null, identity: null, error: "unknown" };
  }
}

module.exports = { connectIdentity, deriveUsername, resolveLoginUser };
