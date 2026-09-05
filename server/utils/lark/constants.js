// Base hosts are overridable so self-hosted/regional Lark deployments (and the
// E2E harness) can point at a different origin. Defaults are the public
// Lark Suite endpoints and are unchanged.
const LARK_BASE_URL = String(
  process.env.LARK_BASE_URL || "https://open.larksuite.com"
).replace(/\/+$/, "");
const LARK_ACCOUNTS_URL = String(
  process.env.LARK_ACCOUNTS_URL || "https://accounts.larksuite.com"
).replace(/\/+$/, "");

const LARK_AUTHORIZE_URL = `${LARK_ACCOUNTS_URL}/open-apis/authen/v1/authorize`;
const LARK_TOKEN_URL = `${LARK_BASE_URL}/open-apis/authen/v2/oauth/token`;
const LARK_USER_INFO_URL = `${LARK_BASE_URL}/open-apis/authen/v1/user_info`;
const APP_ACCESS_TOKEN_URL = `${LARK_BASE_URL}/open-apis/auth/v3/app_access_token/internal`;
const TENANT_ACCESS_TOKEN_URL = `${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`;
const TENANT_QUERY_URL = `${LARK_BASE_URL}/open-apis/tenant/v2/tenant/query`;
const DEFAULT_SCOPES =
  "offline_access contact:user.email:readonly im:message im:message.send_as_user im:chat:readonly docx:document wiki:wiki calendar:calendar contact:user.base:readonly";

module.exports = {
  APP_ACCESS_TOKEN_URL,
  TENANT_ACCESS_TOKEN_URL,
  TENANT_QUERY_URL,
  DEFAULT_SCOPES,
  LARK_ACCOUNTS_URL,
  LARK_AUTHORIZE_URL,
  LARK_BASE_URL,
  LARK_TOKEN_URL,
  LARK_USER_INFO_URL,
};
