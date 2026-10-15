const fs = require("node:fs");
const path = require("node:path");

const HEADER =
  "// Generated from the fork SQLite schema by scripts/database/postgresql-schema.cjs.\n";

function buildPostgresqlSchema(source) {
  if (
    typeof source !== "string" ||
    !/datasource db\s*\{\s*provider\s*=\s*"sqlite"/.test(source)
  ) {
    throw new Error("Expected the fork SQLite schema as the source.");
  }
  const start = source.indexOf("model ");
  if (start < 0) throw new Error("Source schema contains no models.");
  const models = source.slice(start);
  if (models.includes("@db.")) {
    throw new Error(
      "Provider-specific source annotations need explicit review."
    );
  }
  const converted = models.replace(
    /^(\s*\w+\s+DateTime\??[^\n]*?)(\s*\/\/[^\n]*)?$/gm,
    "$1 @db.Timestamptz(3)$2"
  );
  return `${HEADER}generator client {
  provider = "prisma-client-js"
  output   = "../../generated/prisma-postgresql"
}

datasource db {
  provider = "postgresql"
  url      = env("ANYTHINGLLM_DATABASE_URL")
}

${converted}`;
}

function main() {
  const mode = process.argv[2];
  if (!["--write", "--check"].includes(mode) || process.argv.length !== 3) {
    throw new Error(
      "Use --write or --check for the derived PostgreSQL schema."
    );
  }
  const root = path.resolve(__dirname, "../../server/prisma");
  const target = path.join(root, "postgresql/schema.prisma");
  const expected = buildPostgresqlSchema(
    fs.readFileSync(path.join(root, "schema.prisma"), "utf8")
  );
  const existing = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8")
    : null;
  if (mode === "--check") {
    if (existing !== expected)
      throw new Error("PostgreSQL schema is missing or out of sync.");
    console.log("PostgreSQL schema matches the complete fork schema.");
    return;
  }
  if (existing !== null && !existing.startsWith(HEADER)) {
    throw new Error("Refusing to overwrite an unfamiliar PostgreSQL schema.");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
  console.log("Generated the PostgreSQL schema; SQLite source unchanged.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildPostgresqlSchema };
