const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createArtifact(provider) {
  if (provider === "sqlite") return { provider };
  if (provider !== "postgresql") throw new Error("Unsupported build provider.");
  const root = path.resolve(__dirname, "../../server/prisma/postgresql");
  const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const migrations = fs
    .readdirSync(path.join(root, "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sha256: hash(path.join(root, "migrations", name, "migration.sql")),
    }));
  if (migrations.length === 0)
    throw new Error("PG artifact requires migrations.");
  return {
    provider,
    schemaSha256: hash(path.join(root, "schema.prisma")),
    migrations,
  };
}

if (require.main === module) {
  const provider = process.argv[2];
  const output = path.resolve(
    __dirname,
    "../../server/utils/prisma/artifact.json"
  );
  try {
    if (process.argv.length !== 3)
      throw new Error("Supply the build provider.");
    fs.writeFileSync(
      output,
      JSON.stringify(createArtifact(provider), null, 2) + "\n"
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createArtifact };
