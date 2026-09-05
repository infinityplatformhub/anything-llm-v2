const path = require("path");

const root = path.resolve(__dirname, "../..");
// Gateway endpoint lives in e2e/gateway.json so the suites and start-server.sh
// name it once. Env vars still win, for pointing a run at another gateway.
const gateway = require("../gateway.json");

module.exports = {
  AIG_BASE_URL: process.env.AIG_BASE_URL || gateway.baseUrl,
  AIG_MODEL: process.env.AIG_MODEL || gateway.model,
  E2E_A_URL: process.env.E2E_A_URL || "http://localhost:3011",
  E2E_B_URL: process.env.E2E_B_URL || "http://localhost:3012",
  E2E_LOG_A: process.env.E2E_LOG_A || path.join(root, "e2e/logs/server-A.log"),
  E2E_LOG_B: process.env.E2E_LOG_B || path.join(root, "e2e/logs/server-B.log"),
  E2E_STORAGE_A: process.env.E2E_STORAGE_A || path.join(root, "e2e/.state/A/storage"),
  E2E_STORAGE_B: process.env.E2E_STORAGE_B || path.join(root, "e2e/.state/B/storage"),
  AIG_API_KEY: process.env.AIG_API_KEY,
};
