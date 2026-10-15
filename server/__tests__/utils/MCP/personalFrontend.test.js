const { describe, it, expect } = require("@jest/globals");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const frontend = path.resolve(__dirname, "../../../../frontend/src");
describe("personal frontend contract", () => {
  it("accepts personal opt-in but rejects mixed workspace/personal auth", () => {
    const source = fs
      .readFileSync(path.join(frontend, "models/workspaceMcp.js"), "utf8")
      .replace(/^import .*;$/gm, "")
      .replace(/export default WorkspaceMcp;/, "")
      .replace(/export /g, "");
    const context = vm.createContext({ URL, TextEncoder });
    vm.runInContext(
      source + ";globalThis.validate = validateMcpConfig;",
      context
    );
    const config = {
      url: "https://configurable.example/mcp",
      anythingllm: { perUserAuth: true },
    };
    expect(context.validate(config)).toBeNull();
    expect(
      context.validate({
        ...config,
        anythingllm: { perUserAuth: true, perWorkspaceAuth: true },
      })
    ).toBe("invalid_anythingllm");
  });
  // Member access and OAuth actions are exercised in the browser by
  // ../../frontend/personalMcpSettings.test.js, rather than checking JSX text.
});

it("frontend mirrors personal auth descriptor and shared-secret rejection", () => {
  const source = fs.readFileSync(path.join(frontend, "models/workspaceMcp.js"), "utf8")
    .replace(/^import .*;$/gm, "").replace(/export default WorkspaceMcp;/, "").replace(/export /g, "");
  const context = vm.createContext({ URL, TextEncoder });
  vm.runInContext(source + ";globalThis.validate = validateMcpConfig;", context);
  const config = {
    url: "https://configurable.example/mcp",
    anythingllm: { perUserAuth: true, personalAuth: { type: "apiKey", header: "X-API-Key" } },
  };
  expect(context.validate(config)).toBeNull();
  for (const personalAuth of [null, [], { type: "unknown" }, { type: "apiKey" }, { type: "apiKey", header: "Authorization" }, { type: "oauth", header: "X-API-Key" }])
    expect(context.validate({ ...config, anythingllm: { perUserAuth: true, personalAuth } })).toBe("invalid_personal_auth");
  for (const header of ["X-API-Key", "Authorization", "Cookie"])
    expect(context.validate({ ...config, headers: { [header]: "private-shared" } })).toBe("invalid_personal_auth");
  expect(context.validate({ ...config, headers: { Accept: "application/json" } })).toBeNull();
  expect(context.validate({ ...config, anythingllm: { perUserAuth: true, categoryLoading: true } })).toBeNull();
});
