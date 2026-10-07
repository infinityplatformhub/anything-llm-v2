jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
const { dumpENV } = require("../../../utils/helpers/updateENV");

it("preserves upstream operational overrides and local Lark/embed keys on settings saves", () => {
  const values = {
    WORKSPACE_DELETION_PROTECTION: "true",
    AWS_BEDROCK_LLM_MANTLE_ENDPOINT: "https://mantle.example.test",
    AWS_BEDROCK_LLM_RUNTIME_ENDPOINT: "https://runtime.example.test",
    AWS_BEDROCK_LLM_CONTROL_ENDPOINT: "https://control.example.test",
    GENERIC_OPEN_AI_EMBEDDING_API_DELAY_MS: "100",
    MEMORY_EXTRACTION_INTERVAL: "120000",
    MEMORY_IDLE_THRESHOLD_MS: "60000",
    SCHEDULED_JOB_MAX_CONCURRENT: "3",
    SCHEDULED_JOB_TIMEOUT_MS: "120000",
    DOCUMENT_SYNC_STALE_AFTER_MS: "600000",
    CEREBRAS_MODEL_TOKEN_LIMIT: "8192",
    DEEPSEEK_MAX_TOKENS: "4096",
    LLMMAN_RESPONSE_TIMEOUT: "30000",
    VERTEX_AI_LLM_MAX_TOKENS: "4096",
    SERVER_URL: "https://app.example.test",
    LARK_BASE_URL: "https://open.example.test",
    LARK_ACCOUNTS_URL: "https://accounts.example.test",
    LARK_CLI_PATH: "/opt/bin/lark-cli",
    EMBED_REQUIRE_ALLOWLIST: "true",
  };
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const write = jest.spyOn(require("fs"), "writeFileSync").mockImplementation(() => {});
  try {
    Object.assign(process.env, values);
    expect(dumpENV()).toBe(true);
    const text = write.mock.calls[0][1];
    for (const [key, value] of Object.entries(values)) expect(text).toContain(`${key}='${value}'`);
  } finally {
    write.mockRestore();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
