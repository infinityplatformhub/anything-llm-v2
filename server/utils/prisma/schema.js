const fs = require("fs");
const path = require("path");

// Inspect the reviewed generated DDL, not application rows. Migration checksums
// alone cannot detect later ALTER TABLE / DROP INDEX schema drift.
async function verifySchemaCatalog(query) {
  const migrations = path.resolve(
    __dirname,
    "../../prisma/postgresql/migrations"
  );
  const ddl = fs
    .readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) =>
      fs.readFileSync(path.join(migrations, name, "migration.sql"), "utf8")
    )
    .join("\n");
  const columns = await query(
    "SELECT table_name,column_name,column_default,is_nullable,data_type,datetime_precision,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS owned_sequence FROM information_schema.columns WHERE table_schema='public'"
  );
  const indexes = await query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'"
  );
  const constraints =
    await query(`SELECT c.conname,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'`);
  const normalize = (value) =>
    value
      .replace(/"/g, "")
      .replace(/\bpublic\./g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*,\s*/g, ",")
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)/g, ")")
      .trim();
  const foreignKey = (value) => {
    const normalized = normalize(value);
    const deletion =
      normalized.match(
        / ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)/
      )?.[1] || "NO ACTION";
    const update =
      normalized.match(
        / ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)/
      )?.[1] || "NO ACTION";
    return (
      normalized.replace(
        / ON (DELETE|UPDATE) (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)/g,
        ""
      ) + ` DELETE ${deletion} UPDATE ${update}`
    );
  };
  for (const match of ddl.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    const declared = [...match[2].matchAll(/^\s*"(\w+)"\s+/gm)].map(
      (field) => field[1]
    );
    const actualNames = columns
      .filter((column) => column.table_name === match[1])
      .map((column) => column.column_name);
    if (JSON.stringify(declared.sort()) !== JSON.stringify(actualNames.sort()))
      throw new Error("Schema columns mismatch.");
    for (const line of match[2].split("\n")) {
      const field = line.match(/^\s*"(\w+)"\s+([\s\S]*?)(?:,)?$/);
      if (!field) continue;
      const actual = columns.find(
        (column) =>
          column.table_name === match[1] && column.column_name === field[1]
      );
      if (!actual) throw new Error("Schema field missing.");
      const type = field[2].match(
        /^(SERIAL|INTEGER|TEXT|BOOLEAN|DOUBLE PRECISION|TIMESTAMPTZ\(3\))/
      )?.[1];
      const types = {
        SERIAL: "integer",
        INTEGER: "integer",
        TEXT: "text",
        BOOLEAN: "boolean",
        "DOUBLE PRECISION": "double precision",
        "TIMESTAMPTZ(3)": "timestamp with time zone",
      };
      if (
        !type ||
        actual.data_type !== types[type] ||
        actual.is_nullable !== (field[2].includes("NOT NULL") ? "NO" : "YES") ||
        (type === "TIMESTAMPTZ(3)" && actual.datetime_precision !== 3)
      )
        throw new Error("Schema column type/nullability mismatch.");
      const expected =
        field[2].match(/\bDEFAULT (.+)$/)?.[1]?.replace(/,$/, "") || null;
      if (field[2].startsWith("SERIAL")) {
        const sequence = `${match[1]}_${field[1]}_seq`;
        if (
          normalize(actual.column_default || "") !==
            `nextval('${sequence}'::regclass)` ||
          normalize(actual.owned_sequence || "") !== sequence
        )
          throw new Error("Schema sequence default mismatch.");
      } else if (expected === null) {
        if (actual.column_default !== null)
          throw new Error("Unexpected schema default.");
      } else {
        const actualDefault = (actual.column_default || "").replace(
          /::(?:text|double precision|integer|boolean)\b/g,
          ""
        );
        if (normalize(actualDefault) !== normalize(expected))
          throw new Error("Schema default mismatch.");
      }
    }
    const primary = match[2].match(
      /CONSTRAINT "(\w+)" PRIMARY KEY \(([^)]+)\)/
    );
    if (
      !primary ||
      !constraints.some(
        (constraint) =>
          constraint.conname === primary[1] &&
          normalize(constraint.definition) ===
            normalize("PRIMARY KEY(" + primary[2] + ")")
      )
    )
      throw new Error("Schema primary key mismatch.");
  }
  const expectedIndexes = [
    ...ddl.matchAll(/CREATE (UNIQUE )?INDEX "(\w+)" ON "(\w+)"\(([^)]+)\);/g),
  ];
  for (const match of expectedIndexes) {
    const expected = `CREATE ${match[1] || ""}INDEX ${match[2]} ON ${match[3]} USING btree(${match[4]})`;
    if (
      !indexes.some(
        (index) =>
          index.indexname === match[2] &&
          normalize(index.indexdef) === normalize(expected)
      )
    )
      throw new Error("Schema index mismatch.");
  }
  const expectedForeignKeys = [
    ...ddl.matchAll(
      /ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" (FOREIGN KEY .+);/g
    ),
  ];
  for (const match of expectedForeignKeys) {
    if (
      !constraints.some(
        (constraint) =>
          constraint.conname === match[2] &&
          foreignKey(constraint.definition) === foreignKey(match[3])
      )
    ) {
      throw new Error("Schema foreign key mismatch.");
    }
  }
}

module.exports = { verifySchemaCatalog };
