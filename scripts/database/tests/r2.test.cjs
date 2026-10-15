const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function setup(run) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-r2-adapter-")
  );
  try {
    const credentialsFile = path.join(root, "credentials");
    fs.writeFileSync(credentialsFile, "synthetic-only-secret-sentinel", {
      mode: 0o600,
    });
    const calls = [];
    const runner = (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, stdout: '{"Contents":[]}', stderr: "" };
    };
    const options = {
      credentialsFile,
      endpoint: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
      bucket: "anything-llm-backup",
      runner,
    };
    await run({ root, calls, options });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

test("mounts credential references without exposing values or deleting objects", async () => {
  const { createR2Transport } = require("../r2.cjs");
  await setup(async ({ root, calls, options }) => {
    const transport = createR2Transport(options);
    const file = path.join(root, "payload.enc");
    fs.writeFileSync(file, "ciphertext", { mode: 0o600 });
    await transport.put("fixture/payload.enc", file);
    const call = calls[0];
    assert.equal(call.executable, "docker");
    assert.ok(call.args.includes("--if-none-match"));
    assert.ok(call.args.includes("*"));
    assert.ok(call.args.includes("s3api"));
    assert.ok(call.args.includes("put-object"));
    assert.ok(!JSON.stringify(call).includes("secret-sentinel"));
    assert.ok(
      call.args.some((arg) =>
        arg.includes("target=/protected/credentials,readonly")
      )
    );
    assert.equal(transport.delete, undefined);
  });
});

test("distinguishes existing objects from a successful empty list", async () => {
  const { createR2Transport } = require("../r2.cjs");
  await setup(async ({ options }) => {
    assert.equal(
      await createR2Transport(options).exists("fixture/payload.enc"),
      false
    );
    const transport = createR2Transport({
      ...options,
      runner: () => ({
        status: 0,
        stdout: '{"Contents":[{"Key":"fixture/payload.enc"}]}',
        stderr: "",
      }),
    });
    assert.equal(await transport.exists("fixture/payload.enc"), true);
  });
});

test("forbidden and network failures are not treated as object absence", async () => {
  const { createR2Transport } = require("../r2.cjs");
  await setup(async ({ options }) => {
    const transport = createR2Transport({
      ...options,
      runner: () => ({
        status: 1,
        stdout: "",
        stderr: "secret-sentinel AccessDenied",
      }),
    });
    await assert.rejects(transport.exists("fixture/payload.enc"), (error) => {
      assert.ok(!String(error).includes("secret-sentinel"));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test("rejects wrong destination, endpoint and unsafe object paths", async () => {
  const { createR2Transport } = require("../r2.cjs");
  await setup(async ({ calls, options }) => {
    assert.throws(() =>
      createR2Transport({ ...options, bucket: "another-project" })
    );
    assert.throws(() =>
      createR2Transport({ ...options, endpoint: "http://localhost" })
    );
    const transport = createR2Transport(options);
    await assert.rejects(transport.exists("../escape"));
    assert.equal(calls.length, 0);
  });
});

test("requires a protected regular credential file", async () => {
  const { createR2Transport } = require("../r2.cjs");
  await setup(async ({ options }) => {
    fs.chmodSync(options.credentialsFile, 0o644);
    assert.throws(() => createR2Transport(options));
  });
});
