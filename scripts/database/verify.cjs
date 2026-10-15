const {
  identifier,
  decode,
  records,
  validateExport,
  validateTarget,
  fileSha256,
} = require("./export.cjs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

async function verifyOriginalSnapshot(client, request, validated) {
  if (!request.snapshotPath)
    throw new Error("Independent preservation requires the original snapshot.");
  const child = spawn(
    "python3",
    [path.join(__dirname, "original-snapshot.py")],
    {
      env: {
        ...Object.fromEntries(
          ["PATH", "HOME", "TMPDIR", "LANG"]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]])
        ),
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const exit = new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code));
  });
  child.stderr.resume(); // No source values/tracebacks in normal evidence.
  child.stdin.end(
    JSON.stringify({
      snapshot: request.snapshotPath,
      sha256: request.sourceSha256,
      contract: validated.contract,
    })
  );
  let complete = false;
  const sourceBounds = Object.create(null);
  const reader = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      const record = JSON.parse(line);
      if (record.kind === "complete") {
        complete = true;
        continue;
      }
      const table = validated.contract.tables.find(
        (table) => table.name === record.table
      );
      if (!table) throw new Error("Independent preservation table mismatch.");
      if (record.kind === "sequence") {
        if (
          !table.sequenceColumn ||
          Object.hasOwn(sourceBounds, table.name) ||
          (record.sequence !== null &&
            (typeof record.sequence !== "string" ||
              !/^(0|[1-9]\d*)$/.test(record.sequence))) ||
          (record.maximum !== null &&
            (typeof record.maximum !== "string" ||
              !/^-?(0|[1-9]\d*)$/.test(record.maximum))) ||
          record.sequence !== validated.sequences[table.name]
        )
          throw new Error("Independent source sequence mismatch.");
        const maximum = BigInt(record.maximum || "0");
        const sequence = BigInt(record.sequence || "0");
        const high = [0n, maximum, sequence].reduce((left, right) =>
          left > right ? left : right
        );
        if (
          maximum < -2147483648n ||
          maximum > 2147483647n ||
          sequence < 0n ||
          sequence > 2147483647n ||
          high >= 2147483647n
        )
          throw new Error("Independent source sequence capacity mismatch.");
        sourceBounds[table.name] = high;
        continue;
      }
      if (record.kind === "count") {
        if (record.count !== validated.counts[table.name])
          throw new Error("Independent preservation count mismatch.");
        continue;
      }
      if (
        record.kind !== "row" ||
        record.values.length !== table.columns.length
      )
        throw new Error("Independent preservation record mismatch.");
      const keys = table.primaryKey.map(
        (key) =>
          record.values[
            table.columns.findIndex((column) => column.name === key)
          ]
      );
      const row = (
        await client.query(
          `SELECT ${table.columns.map((column) => identifier(column.name)).join(",")} FROM public.${identifier(table.name)} WHERE ${table.primaryKey.map((key, index) => `${identifier(key)}=$${index + 1}`).join(" AND ")}`,
          keys
        )
      ).rows;
      if (
        row.length !== 1 ||
        table.columns.some((column, index) => {
          let actual = row[0][column.name];
          if (actual !== null && column.type === "DateTime")
            actual = actual.toISOString();
          else if (actual !== null && column.type === "Int")
            actual = String(actual);
          return actual !== record.values[index];
        })
      )
        throw new Error("Independent source preservation mismatch.");
    }
    if (
      (await exit) !== 0 ||
      !complete ||
      validated.contract.tables.some(
        (table) =>
          table.sequenceColumn && !Object.hasOwn(sourceBounds, table.name)
      )
    )
      throw new Error("Independent snapshot preservation check failed.");
    return sourceBounds;
  } finally {
    reader.close();
    if (child.exitCode === null) child.kill();
    await exit;
  }
}

async function verifyRows(
  client,
  request,
  validated,
  checkSequences = true,
  sourceBounds
) {
  for (const table of validated.contract.tables) {
    const [row] = (
      await client.query(
        `SELECT count(*)::text AS count FROM public.${identifier(table.name)}`
      )
    ).rows;
    if (BigInt(row.count) !== BigInt(validated.counts[table.name]))
      throw new Error("Data preservation count mismatch.");
  }
  for await (const record of records(request.exportPath)) {
    if (record.kind !== "row") continue;
    const table = validated.contract.tables.find(
      (table) => table.name === record.table
    );
    const values = decode(record.values, table.columns);
    const keys = table.primaryKey.map(
      (key) => values[table.columns.findIndex((column) => column.name === key)]
    );
    const selection = table.columns
      .map((column) => identifier(column.name))
      .join(",");
    const where = table.primaryKey
      .map((key, index) => `${identifier(key)}=$${index + 1}`)
      .join(" AND ");
    const found = (
      await client.query(
        `SELECT ${selection} FROM public.${identifier(table.name)} WHERE ${where}`,
        keys
      )
    ).rows;
    if (
      found.length !== 1 ||
      table.columns.some((column, index) => {
        const actual = found[0][column.name];
        if (column.type === "DateTime" && actual !== null)
          return (
            !(actual instanceof Date) || actual.toISOString() !== values[index]
          );
        return actual !== values[index];
      })
    )
      throw new Error("Data preservation value mismatch.");
  }
  if (checkSequences) {
    for (const table of validated.contract.tables.filter(
      (table) => table.sequenceColumn
    )) {
      if (typeof sourceBounds?.[table.name] !== "bigint")
        throw new Error("Independent source sequence bounds are required.");
      const [sequence] = (
        await client.query("SELECT pg_get_serial_sequence($1,$2) AS name", [
          `public.${identifier(table.name)}`,
          table.sequenceColumn,
        ])
      ).rows;
      if (!sequence.name || !/^public\.[A-Za-z0-9_]+$/.test(sequence.name))
        throw new Error("Data preservation sequence mismatch.");
      const [state] = (
        await client.query(
          `SELECT last_value::text AS value,is_called FROM ${sequence.name}`
        )
      ).rows;
      const [maximum] = (
        await client.query(
          `SELECT max(${identifier(table.sequenceColumn)})::text AS value FROM public.${identifier(table.name)}`
        )
      ).rows;
      const high = [
        0n,
        BigInt(maximum.value || "0"),
        sourceBounds[table.name],
      ].reduce((a, b) => (a > b ? a : b));
      const next = BigInt(state.value) + (state.is_called ? 1n : 0n);
      if (next <= high || next > 2147483647n)
        throw new Error("Data preservation sequence high-water mismatch.");
    }
  }
  if ((await fileSha256(request.exportPath)) !== request.exportSha256)
    throw new Error("Export identity changed during preservation check.");
}

async function verifySnapshot(client, request) {
  const validated = await validateExport(request);
  let begun = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    begun = true;
    await validateTarget(client, request);
    const sourceBounds = await verifyOriginalSnapshot(
      client,
      request,
      validated
    );
    await verifyRows(client, request, validated, true, sourceBounds);
    await client.query("COMMIT");
    begun = false;
    return { status: "VERIFIED", counts: validated.counts };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

module.exports = { verifySnapshot, verifyRows, verifyOriginalSnapshot };
