const crypto = require("node:crypto");

function createSchemaContract(models) {
  const types = new Set(["Int", "String", "Boolean", "Float", "DateTime"]);
  const tables = models.map((model) => {
    const scalar = model.fields.filter((field) => field.kind === "scalar");
    if (scalar.some((field) => !types.has(field.type))) {
      throw new Error("Unsupported scalar type in migration schema.");
    }
    const physical = (field) => field.dbName || field.name;
    const primaryKey = scalar.filter((field) => field.isId).map(physical);
    if (!primaryKey.length)
      throw new Error("Migration requires explicit primary keys.");
    const sequence = scalar.filter(
      (field) => field.default?.name === "autoincrement"
    );
    if (sequence.length > 1) throw new Error("Unsupported sequence mapping.");
    return {
      name: model.dbName || model.name,
      columns: scalar.map((field) => ({
        name: physical(field),
        type: field.type,
        nullable: !field.isRequired,
      })),
      primaryKey,
      sequenceColumn: sequence.length ? physical(sequence[0]) : null,
      parents: [
        ...new Set(
          model.fields
            .filter(
              (field) =>
                field.kind === "object" && field.relationFromFields?.length
            )
            .map((field) => {
              const parent = models.find(
                (candidate) => candidate.name === field.type
              );
              if (!parent) throw new Error("Unresolved migration relation.");
              return parent.dbName || parent.name;
            })
        ),
      ].sort(),
    };
  });
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new Error("Duplicate physical table mapping.");
  }
  const ordered = [];
  const pending = [...tables];
  while (pending.length) {
    const next = pending.findIndex((table) =>
      table.parents.every((parent) =>
        ordered.some((candidate) => candidate.name === parent)
      )
    );
    if (next < 0)
      throw new Error("Cyclic FK dependencies require explicit review.");
    ordered.push(pending.splice(next, 1)[0]);
  }
  return { version: 1, tables: ordered };
}

function contractSha256(contract) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(contract))
    .digest("hex");
}

module.exports = { createSchemaContract, contractSha256 };
