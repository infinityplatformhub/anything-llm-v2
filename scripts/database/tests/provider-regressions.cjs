const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Only replace provider binding. All model methods, Prisma queries, transactions
// and database locks run against the real disposable PG fixture.
function loadModel(name, prisma) {
  const filename = path.resolve(__dirname, "../../../server/models", name);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      require(id) {
        if (id === "../utils/prisma") return prisma;
        if (id === "../utils/prisma/client") {
          return { configuration: { provider: "postgresql" } };
        }
        return realRequire(id);
      },
      console,
      setTimeout,
    },
    { filename }
  );
  return module.exports;
}

async function verifyProviderRegressions({ prisma, admin, url }) {
  const { RecoveryCode } = loadModel("passwordRecovery.js", prisma);
  const user = await prisma.users.create({
    data: { password: "fixture-only" },
  });
  assert.equal(
    await RecoveryCode.issueForUser(user.id, [
      { code_hash: "fixture-hash-a" },
      { code_hash: "fixture-hash-b" },
    ]),
    true
  );
  assert.equal(
    await RecoveryCode.issueForUser(user.id, [{ code_hash: "replacement" }]),
    false
  );
  assert.deepEqual(
    (
      await prisma.recovery_codes.findMany({
        where: { user_id: user.id },
        orderBy: { id: "asc" },
      })
    ).map((row) => row.code_hash),
    ["fixture-hash-a", "fixture-hash-b"]
  );

  // Failure after deleting prior undisclosed codes must roll back everything.
  const rollback = await prisma.users.create({
    data: { password: "fixture-only" },
  });
  await prisma.recovery_codes.create({
    data: { user_id: rollback.id, code_hash: "old-undisclosed" },
  });
  await assert.rejects(
    RecoveryCode.issueForUser(rollback.id, [{ code_hash: null }])
  );
  assert.equal(
    (await prisma.users.findUnique({ where: { id: rollback.id } }))
      .seen_recovery_codes,
    false
  );
  assert.equal(
    (await prisma.recovery_codes.findFirst({ where: { user_id: rollback.id } }))
      .code_hash,
    "old-undisclosed"
  );
  await assert.rejects(
    RecoveryCode.issueForUser(2147483647, [{ code_hash: "missing-user" }])
  );

  const {
    PrismaClient,
  } = require("../../../server/generated/prisma-postgresql");
  const other = new PrismaClient({ datasources: { db: { url } } });
  try {
    const otherRecovery = loadModel("passwordRecovery.js", other).RecoveryCode;
    const concurrent = await prisma.users.create({
      data: { password: "fixture-only" },
    });
    const issued = await Promise.all([
      RecoveryCode.issueForUser(concurrent.id, [{ code_hash: "winner-a" }]),
      otherRecovery.issueForUser(concurrent.id, [{ code_hash: "winner-b" }]),
    ]);
    assert.deepEqual(issued.slice().sort(), [false, true]);
    const stored = await prisma.recovery_codes.findMany({
      where: { user_id: concurrent.id },
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].code_hash, issued[0] ? "winner-a" : "winner-b");

    const { ScheduledJobRun } = loadModel("scheduledJobRun.js", prisma);
    const otherRuns = loadModel("scheduledJobRun.js", other).ScheduledJobRun;
    const job = await prisma.scheduled_jobs.create({
      data: { name: "fixture", prompt: "fixture", schedule: "* * * * *" },
    });
    const unrelated = await prisma.scheduled_jobs.create({
      data: { name: "other", prompt: "fixture", schedule: "* * * * *" },
    });
    await admin.query("BEGIN");
    await admin.query("SELECT id FROM scheduled_jobs WHERE id=$1 FOR UPDATE", [
      job.id,
    ]);
    let completed = 0;
    const first = ScheduledJobRun.start(job.id).then((result) => {
      completed++;
      return result;
    });
    const second = otherRuns.start(job.id).then((result) => {
      completed++;
      return result;
    });
    try {
      // Observe actual database lock waits, not just an arbitrary sleep assertion.
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await admin.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='anythingllm_app' AND wait_event_type='Lock'"
        );
        if (rows[0].count >= 2) {
          blocked = true;
          break;
        }
        if (completed) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(completed, 0, "Claims must wait for the parent job lock");
      assert.equal(
        blocked,
        true,
        "Both independent callers must block on PG locks"
      );
      const freeRun = await ScheduledJobRun.start(unrelated.id);
      assert.ok(
        freeRun,
        "A different job must not be serialized behind this job"
      );
    } finally {
      await admin.query("COMMIT");
      await Promise.allSettled([first, second]);
    }
    const claimed = await Promise.all([first, second]);
    assert.equal(claimed.filter(Boolean).length, 1);
    assert.equal(
      await prisma.scheduled_job_runs.count({ where: { jobId: job.id } }),
      1
    );
    const winner = claimed.find(Boolean);
    assert.equal(await ScheduledJobRun.markRunning(winner.id), true);
    assert.equal(await ScheduledJobRun.start(job.id), null);
    await ScheduledJobRun.complete(winner.id, { result: "fixture-done" });
    assert.ok(
      await ScheduledJobRun.start(job.id),
      "Terminal jobs allow a new run"
    );
  } finally {
    await other.$disconnect();
  }
}

module.exports = { verifyProviderRegressions };
