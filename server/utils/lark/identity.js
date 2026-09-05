const crypto = require("crypto");
const { LarkIdentity } = require("../../models/larkIdentity");
const { User } = require("../../models/user");

const MAX_USERNAME_LENGTH = 64;
const MAX_USERNAME_ATTEMPTS = 1000;

function sanitizeLocalPart(email) {
  if (typeof email !== "string" || !email.includes("@")) return "";
  return email
    .split("@", 1)[0]
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");
}

// Auto-link is only safe when the Lark address genuinely names the account.
// sanitizeLocalPart strips characters, so many distinct addresses collapse onto
// one username; a plus-addressed alias must not be able to select an account.
function exactLocalPart(email) {
  if (typeof email !== "string" || !email.includes("@")) return "";
  const raw = email.split("@", 1)[0].toLowerCase();
  return raw && sanitizeLocalPart(email) === raw ? raw : "";
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
  let fallback = `lark_${String(openId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 12)}`;
  if (!isValidUsername(fallback))
    fallback = `lark_${crypto.randomBytes(6).toString("hex")}`;
  const base = isValidUsername(localPart) ? localPart : fallback;

  if (!(await exists(base))) return base;
  for (let suffix = 2; suffix <= MAX_USERNAME_ATTEMPTS; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${base.slice(0, MAX_USERNAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!(await exists(candidate))) return candidate;
  }

  if (!(await exists(fallback))) return fallback;
  return `${fallback.slice(0, MAX_USERNAME_LENGTH - 6)}${crypto.randomBytes(3).toString("hex")}`;
}

function identityData({ userId, userInfo, tokens, encryption }) {
  return {
    ...(userId == null ? {} : { user_id: Number(userId) }),
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

function tokenData({ tokens, encryption }) {
  return {
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
  return (
    error?.code === "P2002" ||
    message?.includes("P2002") ||
    message?.includes("Unique constraint")
  );
}

async function updateOwnedIdentity(identity, { tokens, encryption }) {
  const result = await LarkIdentity.updateTokens(
    identity.id,
    tokenData({ tokens, encryption })
  );
  return result.error
    ? { identity: null, error: "unknown" }
    : { identity: result.identity, error: null };
}

async function createIdentity(args) {
  let result;
  try {
    result = await LarkIdentity.createForUser(identityData(args));
  } catch (error) {
    result = { identity: null, error };
  }
  if (!result.error) return { identity: result.identity, error: null };
  if (!isUniqueConflict(result.error))
    return { identity: null, error: "unknown" };

  const owner = await LarkIdentity.get({ open_id: args.userInfo.open_id });
  if (!owner || Number(owner.user_id) !== Number(args.userId))
    return { identity: null, error: "link_conflict" };
  return updateOwnedIdentity(owner, args);
}

function tenantMatches({ config, userInfo }) {
  return Boolean(
    config?.tenantKey &&
      userInfo?.tenant_key &&
      config.tenantKey === userInfo.tenant_key
  );
}

async function connectIdentity({
  userId,
  userInfo,
  tokens,
  config,
  encryption,
}) {
  try {
    if (!tenantMatches({ config, userInfo }))
      return { identity: null, error: "unknown" };

    const openIdentity = await LarkIdentity.get({ open_id: userInfo.open_id });
    if (openIdentity) {
      if (Number(openIdentity.user_id) !== Number(userId))
        return { identity: null, error: "link_conflict" };
      return updateOwnedIdentity(openIdentity, { tokens, encryption });
    }

    const userIdentity = await LarkIdentity.get({ user_id: Number(userId) });
    if (userIdentity) return { identity: null, error: "link_conflict" };

    return createIdentity({ userId, userInfo, tokens, encryption });
  } catch {
    return { identity: null, error: "unknown" };
  }
}

async function resolveLoginUser({ userInfo, tokens, config, encryption }) {
  try {
    if (!tenantMatches({ config, userInfo }))
      return { user: null, identity: null, error: "unknown" };

    const linkedIdentity = await LarkIdentity.get({
      open_id: userInfo.open_id,
    });
    if (linkedIdentity) {
      const user = await User.get({ id: Number(linkedIdentity.user_id) });
      if (!user) return { user: null, identity: null, error: "unknown" };
      if (user.suspended)
        return { user: null, identity: null, error: "suspended" };

      const saved = await updateOwnedIdentity(linkedIdentity, {
        tokens,
        encryption,
      });
      if (saved.error)
        return { user: null, identity: null, error: saved.error };
      return { user, identity: saved.identity, created: false, error: null };
    }

    const localPart = exactLocalPart(userInfo.email);
    if (isValidUsername(localPart)) {
      const user = await User.get({ username: localPart });
      // Privileged accounts are never claimed by an email match. Their owners
      // link Lark deliberately through Settings, so a same-tenant user cannot
      // inherit admin or manager rights by choosing a profile email.
      if (user && user.role === "default") {
        if (user.suspended)
          return { user: null, identity: null, error: "suspended" };
        const saved = await createIdentity({
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
      exists: async (candidate) =>
        Boolean(await User.get({ username: candidate })),
    });
    const password = crypto.randomBytes(32).toString("hex");
    const result = await LarkIdentity.provisionUserWithIdentity({
      user: { username, password, role: "default" },
      identity: identityData({ userInfo, tokens, encryption }),
    });
    if (result.error || !result.user || !result.identity)
      return { user: null, identity: null, error: "unknown" };
    return {
      user: result.user,
      identity: result.identity,
      created: true,
      error: null,
    };
  } catch {
    return { user: null, identity: null, error: "unknown" };
  }
}

module.exports = { connectIdentity, deriveUsername, resolveLoginUser };
