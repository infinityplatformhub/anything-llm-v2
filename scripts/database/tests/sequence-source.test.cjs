const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

function loadModule(file, replacements) {
  const filename = path.join(__dirname, "..", file);
  const nativeRequire = createRequire(filename);
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: loaded,
    __dirname: path.dirname(filename),
    process,
    Date,
    require(name) {
      return Object.hasOwn(replacements, name)
        ? replacements[name]
        : nativeRequire(name);
    },
  });
  return loaded.exports;
}

async function fixture(options, run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "allm-sequence-source-")
  );
  try {
    const snapshotPath = path.join(directory, "sqlite.db");
    const sourceRows = options.empty ? [] : [{ id: 17, name: "synthetic" }];
    execFileSync(
      "python3",
      [
        "-c",
        "import json, sqlite3, sys\n" +
          "request = json.load(sys.stdin)\n" +
          "with sqlite3.connect(request['path']) as db:\n" +
          "    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY' + (' AUTOINCREMENT' if request['autoincrement'] else '') + ', name TEXT NOT NULL)')\n" +
          "    for row in request['rows']:\n" +
          "        db.execute('INSERT INTO users VALUES (?, ?)', (row['id'], row['name']))\n" +
          "    if request['sequence'] is not None:\n" +
          "        db.execute('DELETE FROM sqlite_sequence WHERE name=?', ('users',))\n" +
          "        db.execute('INSERT INTO sqlite_sequence VALUES (?, ?)', ('users', request['sequence']))\n",
      ],
      {
        input: JSON.stringify({
          path: snapshotPath,
          rows: sourceRows,
          autoincrement: options.autoincrement !== false,
          sequence: options.sourceSequence ?? null,
        }),
        env: Object.fromEntries(
          ["PATH", "HOME", "TMPDIR", "LANG"]
            .filter((name) => process.env[name])
            .map((name) => [name, process.env[name]])
        ),
      }
    );
    const contract = {
      version: 1,
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "Int", nullable: false },
            { name: "name", type: "String", nullable: false },
          ],
          primaryKey: ["id"],
          sequenceColumn: "id",
          parents: [],
        },
      ],
    };
    const validated = {
      contract,
      counts: { users: sourceRows.length },
      sequences: {
        users:
          options.exportSequence !== undefined
            ? options.exportSequence
            : options.sourceSequence == null
              ? null
              : String(options.sourceSequence),
      },
    };
    const exportPath = path.join(directory, "export.ndjson");
    fs.writeFileSync(
      exportPath,
      sourceRows
        .map((row) =>
          JSON.stringify({
            kind: "row",
            table: "users",
            values: [
              ["Int", String(row.id)],
              ["String", row.name],
            ],
          })
        )
        .join("\n") + (sourceRows.length ? "\n" : ""),
      { mode: 0o600 }
    );
    const request = {
      snapshotPath,
      sourceSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(snapshotPath))
        .digest("hex"),
      exportPath,
      exportSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(exportPath))
        .digest("hex"),
      stateDirectory: path.join(directory, "state"),
      target: {
        database: "synthetic",
        schema: "public",
        role: "anythingllm_migrator",
      },
    };
    const replacements = {
      "./export.cjs": {
        ...require("../export.cjs"),
        async validateExport() {
          return validated;
        },
        async validateTarget() {},
      },
    };
    const verifier = loadModule("verify.cjs", replacements);
    const importer = loadModule("import.cjs", {
      ...replacements,
      "./verify.cjs": verifier,
    });
    const queries = [];
    let targetRows = options.verifyOnly ? sourceRows.slice() : [];
    let sequence = {
      value: options.targetSequence || "1",
      is_called: !!options.targetSequence,
    };
    const client = {
      async query(sql, values) {
        queries.push(sql);
        if (sql.includes("pg_try_advisory_xact_lock"))
          return { rows: [{ acquired: true }] };
        if (sql.startsWith("SELECT EXISTS"))
          return { rows: [{ populated: targetRows.length > 0 }] };
        if (sql.startsWith("INSERT INTO"))
          targetRows.push({ id: values[0], name: values[1] });
        if (sql.startsWith("SELECT count(*)"))
          return { rows: [{ count: String(targetRows.length) }] };
        if (sql.startsWith("SELECT max("))
          return {
            rows: [
              {
                value: targetRows.length
                  ? String(Math.max(...targetRows.map((row) => row.id)))
                  : null,
              },
            ],
          };
        if (sql.includes("pg_get_serial_sequence"))
          return { rows: [{ name: "public.users_id_seq" }] };
        if (sql.startsWith("SELECT last_value")) return { rows: [sequence] };
        if (sql.startsWith("SELECT setval"))
          sequence = { value: values[1], is_called: values[2] };
        if (sql.startsWith('SELECT "id","name"'))
          return {
            rows: targetRows.filter(
              (row) => String(row.id) === String(values[0])
            ),
          };
        if (sql === "ROLLBACK" && !options.verifyOnly) targetRows = [];
        return { rows: [] };
      },
    };
    await run({
      request,
      validated,
      client,
      queries,
      importer,
      verifier,
      sequence: () => sequence,
    });
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

for (const empty of [false, true]) {
  test(
    "rejects corrupted export bounds before setval: " +
      (empty ? "empty/500" : "17/500"),
    async () => {
      await fixture(
        { empty, sourceSequence: 500, exportSequence: empty ? "0" : "17" },
        async ({ importer, client, request, queries }) => {
          await assert.rejects(importer.importSnapshot(client, request));
          assert.equal(
            queries.some((sql) => sql.startsWith("SELECT setval")),
            false
          );
          assert.equal(queries.includes("COMMIT"), false);
          assert.equal(queries.includes("ROLLBACK"), true);
          assert.equal(
            JSON.parse(
              fs.readFileSync(
                path.join(request.stateDirectory, "target-state.json")
              )
            ).status,
            "UNKNOWN"
          );
        }
      );
    }
  );

  test(
    "independently rejects jointly corrupted export/target bounds: " +
      (empty ? "empty/500" : "17/500"),
    async () => {
      await fixture(
        {
          empty,
          sourceSequence: 500,
          exportSequence: empty ? "0" : "17",
          verifyOnly: true,
          targetSequence: empty ? undefined : "17",
        },
        async ({ verifier, client, request }) => {
          await assert.rejects(
            verifier.verifySnapshot(client, request),
            /Independent.*sequence/
          );
        }
      );
    }
  );

  test(
    "preserves historical bound 500: " + (empty ? "empty" : "id17"),
    async () => {
      await fixture(
        { empty, sourceSequence: 500 },
        async ({ importer, client, request, sequence }) => {
          assert.equal(
            (await importer.importSnapshot(client, request)).status,
            "VERIFIED"
          );
          assert.deepEqual(sequence(), { value: "500", is_called: true });
        }
      );
    }
  );
}

for (const autoincrement of [false, true]) {
  test(
    "empty defaults without " +
      (autoincrement ? "a sqlite_sequence row" : "sqlite_sequence"),
    async () => {
      await fixture(
        { empty: true, autoincrement },
        async ({ importer, client, request, sequence }) => {
          assert.equal(
            (await importer.importSnapshot(client, request)).status,
            "VERIFIED"
          );
          assert.deepEqual(sequence(), { value: "1", is_called: false });
        }
      );
    }
  );
}

test("imported maximum dominates a lower historical sequence", async () => {
  await fixture(
    { sourceSequence: 5 },
    async ({ importer, client, request, sequence }) => {
      assert.equal(
        (await importer.importSnapshot(client, request)).status,
        "VERIFIED"
      );
      assert.deepEqual(sequence(), { value: "17", is_called: true });
    }
  );
});

test("standalone verification rejects a target below independent source bounds", async () => {
  await fixture(
    { sourceSequence: 500, verifyOnly: true, targetSequence: "17" },
    async ({ verifier, client, request }) => {
      await assert.rejects(
        verifier.verifySnapshot(client, request),
        /sequence high-water/
      );
    }
  );
});

for (const sourceSequence of [-1, 1.5, 2147483647, 2147483648]) {
  test(
    "rejects unsafe source sequence " + sourceSequence + " before setval",
    async () => {
      await fixture(
        { empty: true, sourceSequence },
        async ({ importer, client, request, queries }) => {
          await assert.rejects(importer.importSnapshot(client, request));
          assert.equal(
            queries.some((sql) => sql.startsWith("SELECT setval")),
            false
          );
        }
      );
    }
  );
}

test("preserves the last source bound with an allocatable Int next ID", async () => {
  await fixture(
    { empty: true, sourceSequence: 2147483646 },
    async ({ importer, client, request, sequence }) => {
      assert.equal(
        (await importer.importSnapshot(client, request)).status,
        "VERIFIED"
      );
      assert.deepEqual(sequence(), { value: "2147483646", is_called: true });
    }
  );
});

test("standalone verification rejects an exhausted target sequence", async () => {
  await fixture(
    { sourceSequence: 500, verifyOnly: true, targetSequence: "2147483647" },
    async ({ verifier, client, request }) => {
      await assert.rejects(
        verifier.verifySnapshot(client, request),
        /sequence high-water/
      );
    }
  );
});
