const LARK_AUTHORIZE_URL =
  "https://accounts.larksuite.com/open-apis/authen/v1/authorize";
const LARK_TOKEN_URL =
  "https://open.larksuite.com/open-apis/authen/v2/oauth/token";
const LARK_USER_INFO_URL =
  "https://open.larksuite.com/open-apis/authen/v1/user_info";
const DEFAULT_SCOPES =
  "offline_access contact:user.email:readonly im:message im:message.send_as_user im:chat:readonly docx:document wiki:wiki calendar:calendar contact:user.base:readonly";

module.exports = {
  DEFAULT_SCOPES,
  LARK_AUTHORIZE_URL,
  LARK_TOKEN_URL,
  LARK_USER_INFO_URL,
};
