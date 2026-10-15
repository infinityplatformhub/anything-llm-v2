/* global jest */
const { it, expect, afterEach } = require("@jest/globals");
require("../../utils/lark/_polyfill");
const oauth = require("../../../utils/MCP/oauth");
const { SystemSettings } = require("../../../models/systemSettings");
afterEach(() => jest.restoreAllMocks());
it("uses configurable issuer revocation with client_id + token and accepts empty RFC7009 success", async () => {
  const resource = "https://resource.example/mcp";
  jest
    .spyOn(SystemSettings, "get")
    .mockResolvedValue({
      value: JSON.stringify({ [resource]: { client_id: "public-client" } }),
    });
  const fetch = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("oauth-protected-resource"))
      return {
        ok: true,
        json: async () => ({
          resource,
          authorization_servers: ["https://store.teamredball.com"],
        }),
      };
    if (String(url).includes("oauth-authorization-server"))
      return {
        ok: true,
        json: async () => ({
          issuer: "https://store.teamredball.com",
          code_challenge_methods_supported: ["S256"],
          authorization_endpoint:
            "https://store.teamredball.com/mcp-auth/authorize",
          token_endpoint: "https://store.teamredball.com/mcp-auth/token",
          registration_endpoint:
            "https://store.teamredball.com/mcp-auth/register",
          revocation_endpoint: "https://store.teamredball.com/mcp-auth/revoke",
        }),
      };
    return { ok: true, status: 200 };
  });
  expect(
    await oauth.revokeTokens(
      { access_token: "private-access", refresh_token: "private-refresh" },
      resource
    )
  ).toBe(true);
  const revokes = fetch.mock.calls.filter((call) =>
    String(call[0]).includes("/mcp-auth/revoke")
  );
  expect(revokes).toHaveLength(2);
  expect(new URLSearchParams(revokes[0][1].body).get("client_id")).toBe(
    "public-client"
  );
  expect(new URLSearchParams(revokes[0][1].body).get("token")).toBe(
    "private-refresh"
  );
  expect(revokes[0][1].redirect).toBe("error");
  expect(revokes[0][1].headers.Authorization).toBeUndefined();
});
