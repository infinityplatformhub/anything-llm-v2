const {
  identifier,
  decode,
  records,
  validateExport,
  validateTarget,
} = require("./export.cjs");
const { verifyRows, verifyOriginalSnapshot } = require("./verify.cjs");
const fs = require("node:fs");
const path = require("node:path");

async function importSnapshot(client, request) {
  const validated = await validateExport(request);
  let begun = false;
  let writesStarted = false;
  let stateFile;
  const state = (status) => {
    const handle = fs.openSync(stateFile, "r+");
    try {
      fs.ftruncateSync(handle);
      fs.writeFileSync(
        handle,
        JSON.stringify({
          status,
          sourceSha256: request.sourceSha256,
          target: request.target,
        })
      );
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  };
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    const [lock] = (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(1095519565,1346850125) AS acquired"
      )
    ).rows;
    if (!lock.acquired) throw new Error("Another importer owns this target.");
    await validateTarget(client, request);
    await client.query(
      "LOCK TABLE " +
        validated.contract.tables
          .map((table) => "public." + identifier(table.name))
          .join(",") +
        " IN ACCESS EXCLUSIVE MODE NOWAIT"
    );
    for (const table of validated.contract.tables) {
      const [row] = (
        await client.query(
          `SELECT EXISTS(SELECT 1 FROM public.${identifier(table.name)} LIMIT 1) AS populated`
        )
      ).rows;
      if (row.populated)
        throw new Error("Import requires a fresh empty target.");
    }
    if (!request.stateDirectory)
      throw new Error("Protected import state is required.");
    const directory = path.resolve(request.stateDirectory);
    // A retained per-target state marker survives SQL rollback and lost commit
    // acknowledgement. Operators must inspect/quarantine; no automatic retry.
    fs.mkdirSync(directory, { mode: 0o700 });
    stateFile = path.join(directory, "target-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        status: "IN_PROGRESS",
        sourceSha256: request.sourceSha256,
        target: request.target,
      }),
      { flag: "wx", mode: 0o600 }
    );
    state("IN_PROGRESS");
    for await (const record of records(request.exportPath)) {
      if (record.kind !== "row") continue;
      const table = validated.contract.tables.find(
        (table) => table.name === record.table
      );
      const values = decode(record.values, table.columns);
      writesStarted = true;
      await client.query(
        `INSERT INTO public.${identifier(table.name)} (${table.columns.map((column) => identifier(column.name)).join(",")}) VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})`,
        values
      );
    }
    await verifyRows(client, request, validated, false);
    const sourceBounds = await verifyOriginalSnapshot(
      client,
      request,
      validated
    );
    for (const table of validated.contract.tables.filter(
      (table) => table.sequenceColumn
    )) {
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
      const [sequence] = (
        await client.query("SELECT pg_get_serial_sequence($1,$2) AS name", [
          `public.${identifier(table.name)}`,
          table.sequenceColumn,
        ])
      ).rows;
      if (!sequence.name) throw new Error("Missing target sequence.");
      // Sequence updates are not transactional: failures quarantine the target.
      writesStarted = true;
      await client.query("SELECT setval($1::regclass,$2::bigint,$3)", [
        sequence.name,
        high > 0n ? high.toString() : "1",
        high > 0n,
      ]);
    }
    await verifyRows(client, request, validated, true, sourceBounds);
    await client.query("COMMIT");
    begun = false;
    state("VERIFIED");
    return {
      status: "VERIFIED",
      counts: validated.counts,
      sourceSha256: request.sourceSha256,
    };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    if (stateFile) {
      try {
        state("UNKNOWN");
      } catch {}
    }
    const failure = new Error(
      writesStarted
        ? "Import failed or commit uncertain; quarantine target before any retry."
        : "Import rejected: requires a fresh correctly identified target, valid export and no quarantine marker."
    );
    failure.status = writesStarted ? "UNKNOWN" : "REJECTED";
    throw failure;
  }
}

module.exports = { importSnapshot };
