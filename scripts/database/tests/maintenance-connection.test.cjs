const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("requires explicit TLS trust and binds the exact requested target", () => {
  const { maintenanceConnection } = require("../maintenance-connection.cjs");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-maintenance-")
  );
  try {
    const connectionFile = path.join(root, "connection");
    const caFile = path.join(root, "ca.crt");
    fs.writeFileSync(
      connectionFile,
      "postgresql://anythingllm_migrator:synthetic-only@localhost:5432/fixture",
      { mode: 0o600 }
    );
    fs.writeFileSync(caFile, "synthetic-CA-fixture");
    const request = {
      connectionFile,
      caFile,
      target: {
        host: "localhost",
        port: 5432,
        database: "fixture",
        schema: "public",
        role: "anythingllm_migrator",
      },
    };
    const options = maintenanceConnection(request);
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(options.ssl.ca, "synthetic-CA-fixture");
    assert.equal(options.host, "localhost");
    assert.equal(options.database, "fixture");
    assert.equal(options.connectionString, undefined);
    assert.throws(() =>
      maintenanceConnection({
        ...request,
        target: { ...request.target, host: "wrong" },
      })
    );
    assert.throws(() =>
      maintenanceConnection({ ...request, caFile: undefined })
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("does not let URL options disable verification or redirect the connection", () => {
  const { maintenanceConnection } = require("../maintenance-connection.cjs");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-maintenance-")
  );
  try {
    const connectionFile = path.join(root, "connection");
    const caFile = path.join(root, "ca");
    fs.writeFileSync(caFile, "fixture");
    const request = {
      connectionFile,
      caFile,
      target: {
        host: "localhost",
        port: 5432,
        database: "fixture",
        schema: "public",
        role: "anythingllm_migrator",
      },
    };
    for (const suffix of ["?sslmode=disable", "?host=/tmp", "?schema=other"]) {
      fs.writeFileSync(
        connectionFile,
        "postgresql://anythingllm_migrator:secret-sentinel@localhost:5432/fixture" +
          suffix,
        { mode: 0o600 }
      );
      assert.throws(
        () => maintenanceConnection(request),
        (error) => !String(error).includes("secret-sentinel")
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
