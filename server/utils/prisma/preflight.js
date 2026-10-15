const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

async function preflightDatabase({ prisma, Prisma, configuration, artifact }) {
  if (configuration.provider === "sqlite" && artifact.provider === "sqlite")
    return;
  try {
    if (
      configuration.provider !== "postgresql" ||
      artifact.provider !== "postgresql" ||
      !/^[a-f0-9]{64}$/.test(artifact.schemaSha256 || "") ||
      !Array.isArray(artifact.migrations) ||
      !artifact.migrations.length
    )
      throw new Error();
    const connection = new URL(configuration.url);
    const schemaParameters = connection.searchParams.getAll("schema");
    if (
      schemaParameters.length > 1 ||
      (schemaParameters.length === 1 && schemaParameters[0] !== "public")
    )
      throw new Error();
    if (
      connection.searchParams.getAll("sslmode").length !== 1 ||
      connection.searchParams.get("sslmode") !== "require" ||
      connection.searchParams.getAll("sslaccept").length !== 1 ||
      connection.searchParams.get("sslaccept") !== "strict" ||
      connection.searchParams.getAll("sslcert").length !== 1 ||
      !path.isAbsolute(connection.searchParams.get("sslcert") || "")
    )
      throw new Error();
    const limit = connection.searchParams.get("connection_limit");
    if (
      connection.searchParams.getAll("connection_limit").length !== 1 ||
      !/^[1-9]\d*$/.test(limit || "") ||
      Number(limit) >= 50
    )
      throw new Error();
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../prisma/postgresql/schema.prisma")
    );
    if (
      crypto.createHash("sha256").update(schema).digest("hex") !==
      artifact.schemaSha256
    )
      throw new Error();
    const models = Prisma.dmmf.datamodel.models;
    if (!models.length) throw new Error();
    const [identity] = await prisma.$queryRawUnsafe(`
      SELECT current_user AS role, current_database() AS database,
        r.rolsuper, r.rolcreatedb, r.rolcreaterole,
        has_schema_privilege(current_user,'public','CREATE') AS can_create,
        has_database_privilege(current_user,current_database(),'CREATE') AS can_create_schema
      FROM pg_roles r WHERE r.rolname=current_user`);
    const database = decodeURIComponent(
      new URL(configuration.url).pathname.slice(1)
    );
    if (
      !identity ||
      identity.role !== "anythingllm_app" ||
      identity.database !== database ||
      identity.rolsuper ||
      identity.rolcreatedb ||
      identity.rolcreaterole ||
      identity.can_create ||
      identity.can_create_schema
    )
      throw new Error();

    const ledger = await prisma.$queryRawUnsafe(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name'
    );
    if (ledger.length !== artifact.migrations.length) throw new Error();
    for (let i = 0; i < ledger.length; i++) {
      const expected = artifact.migrations[i];
      if (
        !/^[a-f0-9]{64}$/.test(expected.sha256 || "") ||
        ledger[i].migration_name !== expected.name ||
        ledger[i].checksum !== expected.sha256 ||
        !ledger[i].finished_at ||
        ledger[i].rolled_back_at
      )
        throw new Error();
    }
    const [privileges] = await prisma.$queryRawUnsafe(`SELECT
      has_table_privilege(current_user,'public."_prisma_migrations"','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ledger_write`);
    if (!privileges || privileges.ledger_write) throw new Error();
    const columns = await prisma.$queryRawUnsafe(
      "SELECT table_name,column_name,is_nullable,data_type,datetime_precision FROM information_schema.columns WHERE table_schema='public'"
    );
    const expectedTypes = {
      Int: "integer",
      String: "text",
      Boolean: "boolean",
      Float: "double precision",
      DateTime: "timestamp with time zone",
    };
    const tables = [
      ...new Set(columns.map((column) => column.table_name)),
    ].sort();
    if (
      JSON.stringify(tables) !==
      JSON.stringify(
        [
          ...models.map((model) => model.dbName || model.name),
          "_prisma_migrations",
        ].sort()
      )
    )
      throw new Error();
    for (const model of models) {
      const actual = columns.filter(
        (column) => column.table_name === (model.dbName || model.name)
      );
      const fields = model.fields.filter((field) => field.kind === "scalar");
      if (actual.length !== fields.length) throw new Error();
      for (const field of fields) {
        const column = actual.find(
          (column) => column.column_name === (field.dbName || field.name)
        );
        if (
          !column ||
          column.is_nullable !== (field.isRequired ? "NO" : "YES") ||
          column.data_type !== expectedTypes[field.type] ||
          (field.type === "DateTime" && column.datetime_precision !== 3)
        )
          throw new Error();
      }
    }
    const rights = await prisma.$queryRawUnsafe(`SELECT
      c.relname,
      has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
        AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE') AS crud,
      pg_has_role(current_user,c.relowner,'USAGE') AS owns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'`);
    if (
      rights.length !== models.length ||
      rights.some((row) => !row.crud || row.owns)
    )
      throw new Error();
    const sequences = await prisma.$queryRawUnsafe(`SELECT
      has_sequence_privilege(current_user,c.oid,'USAGE') AS usable,
      has_sequence_privilege(current_user,c.oid,'SELECT') AS readable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'`);
    if (sequences.some((row) => !row.usable || !row.readable))
      throw new Error();
    await require("./schema").verifySchemaCatalog((sql) =>
      prisma.$queryRawUnsafe(sql)
    );
  } catch {
    // Connection errors may embed URLs or settings; expose only a fixed verdict.
    throw new Error(
      "PostgreSQL preflight failed: check artifact, schema and runtime privileges."
    );
  }
}

module.exports = { preflightDatabase };
