const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");

test("maps every physical fork field and orders parents before children", () => {
  const { createSchemaContract } = require("../schema-contract.cjs");
  const models = require("../../../server/generated/prisma-postgresql").Prisma
    .dmmf.datamodel.models;
  const contract = createSchemaContract(models);
  assert.equal(contract.version, 1);
  assert.equal(contract.tables.length, 40);
  const names = contract.tables.map((table) => table.name);
  for (const table of contract.tables) {
    for (const parent of table.parents)
      assert.ok(names.indexOf(parent) < names.indexOf(table.name));
  }
  const memory = contract.tables.find((table) => table.name === "memories");
  assert.ok(memory.columns.some((column) => column.name === "user_id"));
  assert.ok(!memory.columns.some((column) => column.name === "userId"));
  assert.equal(memory.sequenceColumn, "id");
  const oauth = contract.tables.find(
    (table) => table.name === "lark_oauth_states"
  );
  assert.deepEqual(oauth.primaryKey, ["state"]);
  assert.equal(oauth.sequenceColumn, null);
});

test("rejects unknown scalar types instead of treating them as text", () => {
  const { createSchemaContract } = require("../schema-contract.cjs");
  assert.throws(() =>
    createSchemaContract([
      {
        name: "unknown",
        fields: [{ name: "id", kind: "scalar", type: "Bytes", isId: true }],
      },
    ])
  );
});

test("rejects cyclic FK dependencies instead of disabling constraints", () => {
  const { createSchemaContract } = require("../schema-contract.cjs");
  const model = (name, parent) => ({
    name,
    fields: [
      { name: "id", kind: "scalar", type: "Int", isId: true, isRequired: true },
      {
        name: "parent",
        kind: "object",
        type: parent,
        relationFromFields: ["parent_id"],
      },
    ],
  });
  assert.throws(() => createSchemaContract([model("a", "b"), model("b", "a")]));
});
