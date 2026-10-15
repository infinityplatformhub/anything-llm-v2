const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

async function verifyImportRegressions({ client }) {
  const { importSnapshot } = require("../import.cjs");
  const { verifySnapshot } = require("../verify.cjs");
  const {
    createSchemaContract,
    contractSha256,
  } = require("../schema-contract.cjs");
  const contract = createSchemaContract(
    require("../../../server/generated/prisma-postgresql").Prisma.dmmf.datamodel
      .models
  );
  const artifact = require("../provider-artifact.cjs").createArtifact(
    "postgresql"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-import-"));
  const file = path.join(root, "fixture.ndjson");
  const rows = {
    users: [
      {
        id: 17,
        username: "fixture-import",
        password: "unchanged-hash",
        role: "default",
        suspended: 0,
        seen_recovery_codes: false,
        createdAt: "2024-01-01T00:00:00.123Z",
        lastUpdatedAt: "2024-01-02T00:00:00.456Z",
      },
    ],
    workspaces: [
      {
        id: 29,
        name: "ไทย",
        slug: "fixture-import",
        createdAt: "2024-01-01T00:00:00.123Z",
        lastUpdatedAt: "2024-01-02T00:00:00.456Z",
        openAiHistory: 20,
      },
    ],
    memories: [
      {
        id: 31,
        user_id: 17,
        workspace_id: 29,
        scope: "workspace",
        content: '{ "ciphertext": "unchanged:iv" }',
        created_at: "2024-01-01T00:00:00.123Z",
        updated_at: "2024-01-02T00:00:00.456Z",
      },
    ],
    lark_oauth_states: [
      {
        state: "fixture-state",
        code_verifier: "fixture-verifier",
        mode: "login",
        expiresAt: "2024-01-02T00:00:00.456Z",
        createdAt: "2024-01-01T00:00:00.123Z",
      },
    ],
  };
  // Populate every table, not just a few representative models. Explicit FK
  // values follow actual relation metadata and preserve physical @map names.
  const models = require("../../../server/generated/prisma-postgresql").Prisma
    .dmmf.datamodel.models;
  for (const [index, table] of contract.tables.entries()) {
    if (rows[table.name]) continue;
    const row = {};
    for (const column of table.columns) {
      row[column.name] =
        column.type === "Int"
          ? index + 100
          : column.type === "String"
            ? `fixture-${table.name}-${column.name}`
            : column.type === "Boolean"
              ? false
              : column.type === "Float"
                ? 0.25
                : "2024-01-01T00:00:00.123Z";
    }
    const model = models.find(
      (model) => (model.dbName || model.name) === table.name
    );
    for (const relation of model.fields.filter(
      (field) => field.kind === "object" && field.relationFromFields?.length
    )) {
      const parent = models.find((model) => model.name === relation.type);
      for (const [
        index,
        logicalName,
      ] of relation.relationFromFields.entries()) {
        const localField = model.fields.find(
          (field) => field.name === logicalName
        );
        const parentField = parent.fields.find(
          (field) => field.name === relation.relationToFields[index]
        );
        row[localField.dbName || localField.name] =
          rows[parent.dbName || parent.name][0][
            parentField.dbName || parentField.name
          ];
      }
    }
    rows[table.name] = [row];
  }
  const applicationKeys = {
    SIG_KEY: crypto.randomBytes(32).toString("hex"),
    SIG_SALT: crypto.randomBytes(32).toString("hex"),
  };
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    crypto.scryptSync(applicationKeys.SIG_KEY, applicationKeys.SIG_SALT, 32),
    iv
  );
  const settingsPlaintext = '{"synthetic":"restored encrypted settings"}';
  rows.workspace_mcp_servers[0].config =
    Buffer.concat([
      cipher.update(settingsPlaintext, "utf8"),
      cipher.final(),
    ]).toString("hex") +
    ":" +
    iv.toString("hex");
  const records = [
    {
      kind: "header",
      version: 1,
      sourceSha256: "a".repeat(64),
      contractSha256: contractSha256(contract),
    },
  ];
  const counts = {};
  for (const table of contract.tables) {
    records.push({
      kind: "table",
      name: table.name,
      sequence: table.name === "users" ? "500" : null,
    });
    for (const row of rows[table.name] || []) {
      records.push({
        kind: "row",
        table: table.name,
        values: table.columns.map((column) => {
          const value = row[column.name];
          if (value === undefined) {
            assert.ok(
              column.nullable,
              `Missing fixture field ${table.name}.${column.name}`
            );
            return ["null", null];
          }
          return [
            column.type,
            column.type === "Int" || column.type === "Float"
              ? String(value)
              : value,
          ];
        }),
      });
    }
    counts[table.name] = (rows[table.name] || []).length;
    records.push({ kind: "end", table: table.name, count: counts[table.name] });
  }
  records.push({ kind: "complete", counts });
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const request = {
    exportPath: file,
    exportSha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex"),
    sourceSha256: "a".repeat(64),
    contract,
    artifact,
    target: {
      database: "fixture",
      schema: "public",
      role: "anythingllm_migrator",
    },
    stateDirectory: path.join(root, "import-state"),
  };
  try {
    await client.query("SET ROLE anythingllm_migrator");
    await assert.rejects(
      importSnapshot(client, { ...request, exportSha256: "0".repeat(64) })
    );
    await assert.rejects(
      importSnapshot(client, {
        ...request,
        target: { ...request.target, database: "wrong" },
      })
    );
    await client.query(
      "ALTER TABLE users ADD COLUMN unexpected_default TEXT DEFAULT 'silently invented'"
    );
    await assert.rejects(importSnapshot(client, request));
    await client.query("ALTER TABLE users DROP COLUMN unexpected_default");
    const broken = path.join(root, "broken.ndjson");
    const bad = records.map((record) => JSON.parse(JSON.stringify(record)));
    const memoryRow = bad.find(
      (record) => record.kind === "row" && record.table === "memories"
    );
    const memoryTable = contract.tables.find(
      (table) => table.name === "memories"
    );
    memoryRow.values[
      memoryTable.columns.findIndex((column) => column.name === "user_id")
    ] = ["Int", "999999"];
    fs.writeFileSync(
      broken,
      bad.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 }
    );
    await assert.rejects(
      importSnapshot(client, {
        ...request,
        exportPath: broken,
        exportSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(broken))
          .digest("hex"),
      }),
      /quarantine/
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS count FROM users")).rows[0]
        .count,
      0
    );
    await assert.rejects(importSnapshot(client, request), /quarantine/);
    // A separately chosen fixture run after read-only rollback inspection is
    // not an automatic production retry or deletion of the failed run marker.
    request.stateDirectory = path.join(root, "approved-fixture-state");
    // Fixture-only rollback inspection establishes no committed rows. Actual
    // failed imports still require quarantine/operator decision, not auto retry.
    // Exercise Python's real SQLite capture/export and encrypted publication,
    // rather than importing only a hand-authored export representation.
    const repository = path.resolve(__dirname, "../../..");
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]])
    );
    env.PYTHONDONTWRITEBYTECODE = "1";
    const fixture = path.join(root, "capture-request.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        mode: "capture",
        directory: root,
        contract,
        rows,
        migrations: path.join(repository, "server/prisma/migrations"),
      }),
      { mode: 0o600 }
    );
    const pythonFixture = path.join(__dirname, "fixture_snapshot.py");
    const capture = JSON.parse(
      execFileSync("python3", [pythonFixture, fixture], {
        cwd: root,
        env,
        encoding: "utf8",
      })
    );
    const {
      publishRecoverySet,
      restoreRecoverySet,
    } = require("../publication.cjs");
    const objects = new Map();
    const transport = {
      async exists(key) {
        return objects.has(key);
      },
      async put(key, file) {
        assert.ok(!objects.has(key));
        objects.set(key, fs.readFileSync(file));
      },
      async get(key, file) {
        assert.ok(objects.has(key));
        fs.writeFileSync(file, objects.get(key), { flag: "wx", mode: 0o600 });
      },
    };
    const key = crypto.randomBytes(32);
    const applicationKeyFile = path.join(root, "application-keys.json");
    fs.writeFileSync(applicationKeyFile, JSON.stringify(applicationKeys), {
      mode: 0o600,
    });
    await publishRecoverySet(transport, {
      prefix: "fixture-rehearsal",
      directory: root,
      key,
      payloads: [
        { name: "sqlite", path: path.join(root, "sqlite.db") },
        { name: "storage", path: path.join(root, "storage.tar") },
        { name: "application-keys", path: applicationKeyFile },
      ],
      source: { snapshotSha256: capture.snapshot.sha256 },
    });
    const recovered = await restoreRecoverySet(transport, {
      prefix: "fixture-rehearsal",
      directory: path.join(root, "independent"),
      key,
    });
    const restoreRequest = path.join(root, "restore-request.json");
    fs.writeFileSync(
      restoreRequest,
      JSON.stringify({
        mode: "restore-export",
        directory: path.join(root, "independent"),
        contract,
        snapshot: recovered.payloads.sqlite,
        snapshotSha256: capture.snapshot.sha256,
        archive: recovered.payloads.storage,
        archiveSha256: capture.storage.sha256,
      }),
      { mode: 0o600 }
    );
    const exported = JSON.parse(
      execFileSync("python3", [pythonFixture, restoreRequest], {
        cwd: root,
        env,
        encoding: "utf8",
      })
    );
    Object.assign(request, {
      snapshotPath: recovered.payloads.sqlite,
      exportPath: path.join(root, "independent", "restored-export.ndjson"),
      exportSha256: exported.sha256,
      sourceSha256: capture.snapshot.sha256,
    });
    function sequenceExport(source, tableName, sequence, destination) {
      const modified = fs
        .readFileSync(source, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      modified.find(
        (record) => record.kind === "table" && record.name === tableName
      ).sequence = sequence;
      fs.writeFileSync(
        destination,
        modified.map((record) => JSON.stringify(record)).join("\n") + "\n",
        { flag: "wx", mode: 0o600 }
      );
      return {
        exportPath: destination,
        exportSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(destination))
          .digest("hex"),
      };
    }
    const loweredUsers = sequenceExport(
      request.exportPath,
      "users",
      "17",
      path.join(root, "lowered-users.ndjson")
    );
    const emptyTable = contract.tables.find(
      (table) =>
        table.sequenceColumn &&
        !contract.tables.some((child) => child.parents.includes(table.name))
    );
    assert.ok(emptyTable);
    const emptySnapshot = path.join(root, "empty-high-water.sqlite");
    fs.copyFileSync(request.snapshotPath, emptySnapshot);
    fs.chmodSync(emptySnapshot, 0o600);
    const emptyExport = path.join(root, "empty-high-water.ndjson");
    const emptySource = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import hashlib, json, re, sqlite3, sys\n" +
            "request = json.load(sys.stdin)\n" +
            "assert re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', request['table'])\n" +
            "with sqlite3.connect(request['snapshot']) as db:\n" +
            "    db.execute('PRAGMA foreign_keys=ON')\n" +
            "    db.execute('DELETE FROM ' + request['table'])\n" +
            "    db.execute('UPDATE sqlite_sequence SET seq=500 WHERE name=?', (request['table'],))\n" +
            "with open(request['snapshot'], 'rb') as stream:\n" +
            "    sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()\n" +
            "sys.path.insert(0, request['tools'])\n" +
            "from snapshot import export_snapshot\n" +
            "exported = export_snapshot(request['snapshot'], request['export'], request['contract'], sha256)\n" +
            "print(json.dumps({'sourceSha256': sha256, 'exportSha256': exported['sha256']}))\n",
        ],
        {
          input: JSON.stringify({
            snapshot: emptySnapshot,
            export: emptyExport,
            table: emptyTable.name,
            contract,
            tools: path.join(repository, "scripts/database"),
          }),
          cwd: root,
          env,
          encoding: "utf8",
        }
      )
    );
    const loweredEmpty = sequenceExport(
      emptyExport,
      emptyTable.name,
      "0",
      path.join(root, "lowered-empty.ndjson")
    );
    await require("./independent-postgres.cjs").withIndependentPostgres(
      async (independent) => {
        const restoredRequest = {
          ...request,
          stateDirectory: path.join(root, "independent-target-state"),
        };
        for (const [index, corrupted] of [
          { ...request, ...loweredUsers },
          {
            ...request,
            ...loweredEmpty,
            snapshotPath: emptySnapshot,
            sourceSha256: emptySource.sourceSha256,
          },
        ].entries()) {
          await assert.rejects(
            importSnapshot(independent, {
              ...corrupted,
              stateDirectory: path.join(
                root,
                "source-bound-rejection-" + index
              ),
            }),
            /quarantine/
          );
          assert.equal(
            (
              await independent.query(
                "SELECT count(*)::int AS count FROM users"
              )
            ).rows[0].count,
            0
          );
          assert.deepEqual(
            (
              await independent.query(
                "SELECT last_value::text AS value,is_called FROM public.users_id_seq"
              )
            ).rows[0],
            { value: "1", is_called: false }
          );
        }
        await importSnapshot(independent, restoredRequest);
        await verifySnapshot(independent, restoredRequest);
        await independent.query("SELECT setval('public.users_id_seq',17,true)");
        await assert.rejects(
          verifySnapshot(independent, { ...restoredRequest, ...loweredUsers }),
          /Independent.*sequence/
        );
        await independent.query(
          "SELECT setval('public.users_id_seq',500,true)"
        );
        await verifySnapshot(independent, restoredRequest);
        assert.equal(
          (
            await independent.query(
              "SELECT count(*)::int AS count FROM lark_oauth_states"
            )
          ).rows[0].count,
          1
        );
      }
    );
    const result = await importSnapshot(client, request);
    assert.equal(result.status, "VERIFIED");
    assert.deepEqual(result.counts, counts);
    assert.equal(
      (await client.query("SELECT nextval('users_id_seq') AS id")).rows[0].id,
      "501"
    );
    await verifySnapshot(client, request);
    // Deliberately corrupt both the export and target identically. An export-only
    // comparator would pass; independent original-SQLite comparison must fail.
    const sharedCorruption = path.join(root, "shared-corruption.ndjson");
    const corruptedExport = fs
      .readFileSync(request.exportPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const corruptMemory = corruptedExport.find(
      (record) => record.kind === "row" && record.table === "memories"
    );
    corruptMemory.values[
      contract.tables
        .find((table) => table.name === "memories")
        .columns.findIndex((column) => column.name === "content")
    ] = ["String", "shared-export-bug"];
    fs.writeFileSync(
      sharedCorruption,
      corruptedExport.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 }
    );
    await client.query(
      "UPDATE memories SET content='shared-export-bug' WHERE id=31"
    );
    await assert.rejects(
      verifySnapshot(client, {
        ...request,
        exportPath: sharedCorruption,
        exportSha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(sharedCorruption))
          .digest("hex"),
      }),
      /Independent source preservation/
    );
    await client.query("UPDATE memories SET content=$1 WHERE id=31", [
      '{ "ciphertext": "unchanged:iv" }',
    ]);
    await verifySnapshot(client, request);
    // Recovery must use the downloaded effective app keys, not the archived
    // .env or a newly generated pair. No plaintext/key value is logged.
    const restoredKeys = JSON.parse(
      fs.readFileSync(recovered.payloads["application-keys"], "utf8")
    );
    // Execute the real encryption class, replacing only the unrelated env-write
    // helper whose imports boot vector/telemetry modules. A write is forbidden:
    // explicit recovered keys must prevent generation/persistence entirely.
    const encryptionModule = { exports: {} };
    require("node:vm").runInNewContext(
      fs.readFileSync(
        path.join(repository, "server/utils/EncryptionManager/index.js"),
        "utf8"
      ),
      {
        module: encryptionModule,
        process: { env: {} },
        Buffer,
        console: { log() {} },
        require(id) {
          if (id === "crypto") return crypto;
          if (id === "../helpers/updateENV")
            return {
              dumpENV() {
                throw new Error("Unexpected recovery key regeneration");
              },
            };
          throw new Error("Unexpected encryption dependency");
        },
      }
    );
    const { EncryptionManager } = encryptionModule.exports;
    const recoveredEncryption = new EncryptionManager({
      key: restoredKeys.SIG_KEY,
      salt: restoredKeys.SIG_SALT,
    });
    const storedSettings = (
      await client.query(
        "SELECT config FROM workspace_mcp_servers ORDER BY id LIMIT 1"
      )
    ).rows[0].config;
    assert.equal(
      recoveredEncryption.decrypt(storedSettings),
      settingsPlaintext
    );
    await assert.rejects(importSnapshot(client, request), /fresh/);
    await client.query("UPDATE memories SET content='corrupted' WHERE id=31");
    await assert.rejects(verifySnapshot(client, request), /preservation/);
    await client.query("UPDATE memories SET content=$1 WHERE id=31", [
      '{ "ciphertext": "unchanged:iv" }',
    ]);
    await verifySnapshot(client, request);
  } finally {
    await client.query("RESET ROLE");
    fs.rmSync(root, { recursive: true });
  }
}

module.exports = { verifyImportRegressions };
