const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

async function scenario(callback) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-publication-")
  );
  const objects = new Map();
  const events = [];
  const transport = {
    async put(object, source) {
      if (objects.has(object)) throw new Error("Object exists");
      events.push(["put", object]);
      objects.set(object, fs.readFileSync(source));
    },
    async get(object, destination) {
      events.push(["get", object]);
      if (!objects.has(object)) throw new Error("Missing object");
      fs.writeFileSync(destination, objects.get(object), {
        flag: "wx",
        mode: 0o600,
      });
    },
    async exists(object) {
      return objects.has(object);
    },
  };
  const payload = path.join(root, "sqlite");
  fs.writeFileSync(payload, "synthetic-sensitive-fixture", { mode: 0o600 });
  const request = {
    prefix: "migration-fixture",
    directory: root,
    key: crypto.randomBytes(32),
    payloads: [{ name: "sqlite", path: payload }],
    source: { snapshotSha256: "a".repeat(64), schemaSha256: "b".repeat(64) },
  };
  try {
    await callback({ root, objects, events, transport, request });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

test("completion marker follows downloaded payload/manifest validation", async () => {
  const {
    publishRecoverySet,
    restoreRecoverySet,
  } = require("../publication.cjs");
  await scenario(async ({ root, events, transport, request }) => {
    const published = await publishRecoverySet(transport, request);
    assert.equal(published.status, "VERIFIED");
    const puts = events.filter(([action]) => action === "put");
    assert.equal(puts.at(-1)[1], "migration-fixture/complete.enc");
    assert.ok(
      events.findIndex(
        ([action, object]) =>
          action === "get" && object.endsWith("manifest.enc")
      ) <
        events.findIndex(
          ([action, object]) =>
            action === "put" && object.endsWith("complete.enc")
        )
    );
    const restored = await restoreRecoverySet(transport, {
      ...request,
      directory: path.join(root, "independent"),
    });
    assert.equal(
      fs.readFileSync(restored.payloads.sqlite, "utf8"),
      "synthetic-sensitive-fixture"
    );
  });
});

test("failed downloaded checksum never publishes completion", async () => {
  const { publishRecoverySet } = require("../publication.cjs");
  await scenario(async ({ objects, transport, request }) => {
    const original = transport.get;
    transport.get = async (object, destination) => {
      await original(object, destination);
      fs.appendFileSync(destination, "corrupt");
    };
    await assert.rejects(publishRecoverySet(transport, request));
    assert.equal(objects.has("migration-fixture/complete.enc"), false);
  });
});

test("does not overwrite a previous recovery prefix", async () => {
  const { publishRecoverySet } = require("../publication.cjs");
  await scenario(async ({ objects, transport, request }) => {
    objects.set("migration-fixture/sqlite.enc", Buffer.from("protected"));
    await assert.rejects(publishRecoverySet(transport, request));
    assert.equal(
      objects.get("migration-fixture/sqlite.enc").toString(),
      "protected"
    );
  });
});

test("incomplete recovery set is rejected without exposing plaintext", async () => {
  const {
    publishRecoverySet,
    restoreRecoverySet,
  } = require("../publication.cjs");
  await scenario(async ({ root, objects, transport, request }) => {
    await publishRecoverySet(transport, request);
    objects.delete("migration-fixture/complete.enc");
    await assert.rejects(
      restoreRecoverySet(transport, {
        ...request,
        directory: path.join(root, "incomplete"),
      })
    );
    assert.equal(fs.existsSync(path.join(root, "incomplete", "sqlite")), false);
  });
});

test("payload authentication fails with wrong independently supplied key", async () => {
  const {
    publishRecoverySet,
    restoreRecoverySet,
  } = require("../publication.cjs");
  await scenario(async ({ root, transport, request }) => {
    await publishRecoverySet(transport, request);
    await assert.rejects(
      restoreRecoverySet(transport, {
        ...request,
        key: crypto.randomBytes(32),
        directory: path.join(root, "wrong-key"),
      })
    );
  });
});
