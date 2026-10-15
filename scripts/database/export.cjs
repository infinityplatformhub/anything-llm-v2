const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");
const {
  createSchemaContract,
  contractSha256,
} = require("./schema-contract.cjs");

function identifier(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("Invalid schema identifier.");
  return '"' + name + '"';
}

async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function* records(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      if (!line) throw new Error("Empty migration export record.");
      yield JSON.parse(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

function decode(values, columns) {
  if (!Array.isArray(values) || values.length !== columns.length)
    throw new Error("Invalid export field count.");
  return values.map((tag, i) => {
    const column = columns[i];
    if (!Array.isArray(tag) || tag.length !== 2)
      throw new Error("Invalid export tag.");
    const [kind, value] = tag;
    if (kind === "null" && value === null && column.nullable) return null;
    if (kind !== column.type || value === null)
      throw new Error("Export type mismatch.");
    if (kind === "Int") {
      if (
        typeof value !== "string" ||
        !/^-?(0|[1-9]\d*)$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < -2147483648 ||
        Number(value) > 2147483647
      )
        throw new Error("Invalid Int value.");
      return Number(value);
    }
    if (kind === "String") {
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.from(value).toString("utf8") !== value
      )
        throw new Error("Invalid String value.");
      return value;
    }
    if (kind === "Boolean" && typeof value === "boolean") return value;
    if (
      kind === "Float" &&
      typeof value === "string" &&
      value.trim() &&
      Number.isFinite(Number(value))
    )
      return Number(value);
    if (
      kind === "DateTime" &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      new Date(value).toISOString() === value
    )
      return value;
    throw new Error("Invalid typed export value.");
  });
}

async function validateExport(request) {
  const expected = createSchemaContract(
    require("../../server/generated/prisma-postgresql").Prisma.dmmf.datamodel
      .models
  );
  if (JSON.stringify(request.contract) !== JSON.stringify(expected))
    throw new Error("Unrecognized source mapping.");
  if (
    !/^[a-f0-9]{64}$/.test(request.sourceSha256 || "") ||
    (await fileSha256(request.exportPath)) !== request.exportSha256
  )
    throw new Error("Export identity mismatch.");
  const stat = fs.lstatSync(request.exportPath);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error("Export must be a protected regular file.");
  let state = "header";
  let index = 0;
  let count = 0;
  const counts = {};
  const sequences = {};
  for await (const record of records(request.exportPath)) {
    if (state === "header") {
      if (
        record.kind !== "header" ||
        record.version !== 1 ||
        record.sourceSha256 !== request.sourceSha256 ||
        record.contractSha256 !== contractSha256(expected)
      )
        throw new Error("Export header mismatch.");
      state = "table";
      continue;
    }
    if (state === "table") {
      const table = expected.tables[index];
      if (!table || record.kind !== "table" || record.name !== table.name)
        throw new Error("Export table order mismatch.");
      if (
        record.sequence !== null &&
        (!table.sequenceColumn ||
          typeof record.sequence !== "string" ||
          !/^(0|[1-9]\d*)$/.test(record.sequence) ||
          Number(record.sequence) > 2147483647)
      )
        throw new Error("Invalid sequence bound.");
      sequences[table.name] = record.sequence;
      count = 0;
      state = "rows";
      continue;
    }
    if (state === "rows") {
      const table = expected.tables[index];
      if (record.table !== table.name)
        throw new Error("Export row table mismatch.");
      if (record.kind === "row") {
        decode(record.values, table.columns);
        count++;
        continue;
      }
      if (record.kind !== "end" || record.count !== count)
        throw new Error("Export table count mismatch.");
      counts[table.name] = count;
      index++;
      state = index === expected.tables.length ? "complete" : "table";
      continue;
    }
    if (
      state !== "complete" ||
      record.kind !== "complete" ||
      JSON.stringify(record.counts) !== JSON.stringify(counts)
    )
      throw new Error("Export completion mismatch.");
    state = "done";
  }
  if (state !== "done") throw new Error("Export is incomplete.");
  return { contract: expected, counts, sequences };
}

async function validateTarget(client, request) {
  const [identity] = (
    await client.query(
      "SELECT current_user AS role,current_database() AS database,current_schema() AS schema"
    )
  ).rows;
  if (
    !request.target ||
    request.target.schema !== "public" ||
    request.target.role !== "anythingllm_migrator" ||
    !identity ||
    Object.keys(identity).some((key) => identity[key] !== request.target[key])
  )
    throw new Error("Target identity mismatch.");
  const expected = require("./provider-artifact.cjs").createArtifact(
    "postgresql"
  );
  if (JSON.stringify(request.artifact) !== JSON.stringify(expected))
    throw new Error("Target artifact mismatch.");
  const ledger = (
    await client.query(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name'
    )
  ).rows;
  if (
    ledger.length !== expected.migrations.length ||
    ledger.some(
      (entry, index) =>
        entry.migration_name !== expected.migrations[index].name ||
        entry.checksum !== expected.migrations[index].sha256 ||
        !entry.finished_at ||
        entry.rolled_back_at
    )
  )
    throw new Error("Target migration history mismatch.");
  const actual = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    )
  ).rows.map((row) => row.tablename);
  if (
    JSON.stringify(actual) !==
    JSON.stringify(
      [
        ...request.contract.tables.map((table) => table.name),
        "_prisma_migrations",
      ].sort()
    )
  )
    throw new Error("Target tables mismatch.");
  await require("../../server/utils/prisma/schema").verifySchemaCatalog(
    async (sql) => (await client.query(sql)).rows
  );
}

module.exports = {
  identifier,
  fileSha256,
  records,
  decode,
  validateExport,
  validateTarget,
};
