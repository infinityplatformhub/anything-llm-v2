/* global jest */
const { describe, it, expect, afterEach } = require("@jest/globals");
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
const {
  validateWorkspaceServerName,
  validateWorkspaceServerConfig: validate,
  maskConfig,
  mergeMaskedConfig,
  parseMcpServersBlock,
  MASKED_SECRET,
} = require("../../../utils/MCP/serverConfig");
const config = { url: "https://mcp.example/mcp" };
const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe("workspace MCP config validation", () => {
  it.each([undefined, "sse", "http", "streamable"])(
    "accepts transport %s",
    (type) => {
      const value = {
        ...config,
        ...(type ? { type } : {}),
        headers: { Authorization: "Bearer secret" },
        anythingllm: { perWorkspaceAuth: true, suppressedTools: ["write"] },
      };
      expect(validate(value)).toEqual(value);
    }
  );
  it.each(["command", "args", "env"])("rejects stdio field %s", (key) => {
    expect(() => validate({ ...config, [key]: null })).toThrow(
      "stdio_not_supported"
    );
  });
  it("rejects unknown top-level and nested fields", () => {
    expect(() => validate({ ...config, timeout: 5 })).toThrow(
      "unknown_field:timeout"
    );
    expect(() => validate({ ...config, anythingllm: { typo: true } })).toThrow(
      "unknown_field:anythingllm.typo"
    );
  });
  it.each([null, [], "config", 1])("rejects non-object config %j", (value) => {
    expect(() => validate(value)).toThrow("invalid_config");
  });
  it.each([
    null,
    [],
    "headers",
    { key: 1 },
    { "bad name": "value" },
    { key: "value\r\ninjected: yes" },
  ])("rejects invalid headers %j", (headers) => {
    expect(() => validate({ ...config, headers })).toThrow("invalid_headers");
  });
  it("bounds header count and serialized UTF-8 bytes", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`x-${i}`, "value"])
    );
    expect(validate({ ...config, headers })).toBeTruthy();
    expect(() =>
      validate({ ...config, headers: { ...headers, extra: "value" } })
    ).toThrow("headers_too_large");
    expect(
      validate({ ...config, headers: { x: "x".repeat(4088) } })
    ).toBeTruthy();
    expect(() =>
      validate({ ...config, headers: { x: "x".repeat(4089) } })
    ).toThrow("headers_too_large");
    expect(() =>
      validate({ ...config, headers: { x: "é".repeat(2045) } })
    ).toThrow("headers_too_large");
  });
  it.each(["stdio", "https", null, 42])("rejects transport %j", (type) => {
    expect(() => validate({ ...config, type })).toThrow("invalid_type");
  });
  it.each([
    null,
    [],
    { perWorkspaceAuth: "true" },
    { suppressedTools: "write" },
    { suppressedTools: [1] },
  ])("rejects anythingllm %j", (anythingllm) => {
    expect(() => validate({ ...config, anythingllm })).toThrow(
      "invalid_anythingllm"
    );
  });
  it.each([
    undefined,
    1,
    "not-a-url",
    "file:///tmp/mcp",
    "https://10.0.0.1/mcp",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://user:secret@mcp.example",
    "https://mcp.example/#secret",
    "http://mcp.example",
  ])("rejects URL without exposing input %j", (url) => {
    process.env.NODE_ENV = "production";
    expect(() => validate({ url })).toThrow(/^invalid_url$/);
  });
  it("preserves httpUrl development-only loopback exception", () => {
    process.env.NODE_ENV = "development";
    expect(validate({ url: "http://127.0.0.1:3000/mcp" })).toBeTruthy();
  });
  it.each(["ab", "erp-01", "x_2", "a".repeat(64)])(
    "accepts name %s",
    (name) => {
      expect(validateWorkspaceServerName(name)).toBe(name);
    }
  );
  it.each([
    "a",
    "",
    "Upper",
    "-abc",
    "a.b",
    "a/b",
    "erp\n",
    "a".repeat(65),
    null,
    12,
  ])("rejects name %j", (name) => {
    expect(() => validateWorkspaceServerName(name)).toThrow("invalid_name");
  });
});

describe("masking and merge", () => {
  it("masks every secret header and leaves input unchanged", () => {
    const headers = {
      Authorization: "secret",
      "X-api-KEY": "secret",
      Cookie: "secret",
      password: "secret",
      "X-Token": "secret",
      "client-secret": "secret",
      Accept: "application/json",
    };
    const value = { ...config, headers };
    const masked = maskConfig(value);
    expect(MASKED_SECRET).toBe("••••••••");
    for (const key of Object.keys(headers).filter((key) => key !== "Accept"))
      expect(masked.headers[key]).toBe(MASKED_SECRET);
    expect(masked.headers.Accept).toBe("application/json");
    expect(value.headers.Authorization).toBe("secret");
    expect(maskConfig(config)).toEqual(config);
  });
  it("keeps sentinel values, replaces new values, removes omitted keys", () => {
    const existing = {
      ...config,
      type: "http",
      headers: { Authorization: "old", "X-Key": "old-key", Cookie: "remove" },
    };
    const incoming = {
      ...config,
      headers: {
        Authorization: MASKED_SECRET,
        "X-Key": "new-key",
        Accept: "json",
      },
    };
    expect(mergeMaskedConfig(existing, incoming)).toEqual({
      ...config,
      headers: { Authorization: "old", "X-Key": "new-key", Accept: "json" },
    });
    expect(mergeMaskedConfig(existing, config)).toEqual(config);
    expect(incoming.headers.Authorization).toBe(MASKED_SECRET);
  });
  it("rejects sentinel without an existing own header", () => {
    for (const key of ["Authorization", "constructor", "__proto__"]) {
      expect(() =>
        mergeMaskedConfig(config, {
          ...config,
          headers: { [key]: MASKED_SECRET },
        })
      ).toThrow("invalid_masked_header");
    }
  });
});

describe("paste JSON parsing", () => {
  it("unpacks multiple entries without validating so batch errors stay independent", () => {
    expect(parseMcpServersBlock({ mcpServers: { a: {}, b: {} } })).toEqual([
      { name: "a", config: {} },
      { name: "b", config: {} },
    ]);
  });
  it("unpacks a single name/config pair", () => {
    expect(parseMcpServersBlock({ name: "erp", config })).toEqual([
      { name: "erp", config },
    ]);
  });
  it.each([
    null,
    [],
    {},
    { mcpServers: {} },
    { mcpServers: [] },
    { mcpServers: null },
    { name: "erp" },
    { mcpServers: { erp: config }, name: "erp", config },
  ])("rejects malformed or ambiguous wrapper %j", (body) => {
    expect(() => parseMcpServersBlock(body)).toThrow("invalid_mcp_servers");
  });
});
