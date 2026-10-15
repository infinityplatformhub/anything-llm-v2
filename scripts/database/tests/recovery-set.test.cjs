const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-recovery-"));
  try {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "fixture-sensitive-ciphertext-ไทย", {
      mode: 0o600,
    });
    await run({ root, source, key: crypto.randomBytes(32) });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

test("encrypts sensitive bytes and independently restores exact plaintext", async () => {
  const { encryptPayload, decryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source, key }) => {
    const encrypted = path.join(root, "encrypted");
    const restored = path.join(root, "restored");
    await encryptPayload(source, encrypted, key);
    assert.ok(
      !fs.readFileSync(encrypted).includes(Buffer.from("fixture-sensitive"))
    );
    await decryptPayload(encrypted, restored, key);
    assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(source));
    assert.equal(fs.statSync(encrypted).mode & 0o777, 0o600);
    assert.equal(fs.statSync(restored).mode & 0o777, 0o600);
  });
});

test("authentication failure never publishes restored plaintext", async () => {
  const { encryptPayload, decryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source, key }) => {
    const encrypted = path.join(root, "encrypted");
    const restored = path.join(root, "restored");
    await encryptPayload(source, encrypted, key);
    await assert.rejects(
      decryptPayload(encrypted, restored, crypto.randomBytes(32)),
      /authentication/
    );
    assert.equal(fs.existsSync(restored), false);
  });
});

test("rejects corrupt and truncated ciphertext", async () => {
  const { encryptPayload, decryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source, key }) => {
    const encrypted = path.join(root, "encrypted");
    await encryptPayload(source, encrypted, key);
    const original = fs.readFileSync(encrypted);
    original[20] ^= 1;
    fs.writeFileSync(encrypted, original);
    await assert.rejects(
      decryptPayload(encrypted, path.join(root, "bad"), key)
    );
    fs.writeFileSync(encrypted, original.subarray(0, 20));
    await assert.rejects(
      decryptPayload(encrypted, path.join(root, "truncated"), key)
    );
  });
});

test("refuses overwriting existing payload and recovery destinations", async () => {
  const { encryptPayload, decryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source, key }) => {
    const encrypted = path.join(root, "encrypted");
    await encryptPayload(source, encrypted, key);
    await assert.rejects(encryptPayload(source, encrypted, key));
    const restored = path.join(root, "restored");
    fs.writeFileSync(restored, "protected");
    await assert.rejects(decryptPayload(encrypted, restored, key));
    assert.equal(fs.readFileSync(restored, "utf8"), "protected");
  });
});

test("requires independently supplied strong key material", async () => {
  const { encryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source }) => {
    await assert.rejects(
      encryptPayload(source, path.join(root, "encrypted"), Buffer.alloc(16))
    );
    assert.equal(fs.existsSync(path.join(root, "encrypted")), false);
  });
});

test("round-trips zero-byte payloads without treating headers as ciphertext", async () => {
  const { encryptPayload, decryptPayload } = require("../recovery-set.cjs");
  await fixture(async ({ root, source, key }) => {
    fs.writeFileSync(source, Buffer.alloc(0));
    await encryptPayload(source, path.join(root, "empty.enc"), key);
    await decryptPayload(
      path.join(root, "empty.enc"),
      path.join(root, "empty"),
      key
    );
    assert.equal(fs.statSync(path.join(root, "empty")).size, 0);
  });
});
