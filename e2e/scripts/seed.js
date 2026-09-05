import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { Client } = require(path.join(root, "server/node_modules/pg"));
const mysql = require(path.join(root, "server/node_modules/mysql2/promise"));
const mssql = require(path.join(root, "server/node_modules/mssql"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(connect, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function seedPostgres() {
  const client = await retry(async () => {
    const candidate = new Client({
      host: "127.0.0.1",
      port: 55432,
      user: "e2e",
      password: "e2epass",
      database: "alpha_db",
    });
    try {
      await candidate.connect();
      return candidate;
    } catch (error) {
      await candidate.end().catch(() => {});
      throw error;
    }
  }, 60000);

  try {
    await client.query(fs.readFileSync(path.join(root, "e2e/seed/postgres.sql"), "utf8"));
    const result = await client.query("SELECT COUNT(*)::int AS count FROM customers");
    return result.rows[0].count;
  } finally {
    await client.end();
  }
}

async function seedMysql() {
  const connection = await retry(
    () =>
      mysql.createConnection({
        host: "127.0.0.1",
        port: 53306,
        user: "e2e",
        password: "e2epass",
        database: "beta_db",
        multipleStatements: true,
      }),
    60000
  );

  try {
    await connection.query(fs.readFileSync(path.join(root, "e2e/seed/mysql.sql"), "utf8"));
    const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM customers");
    return Number(row.count);
  } finally {
    await connection.end();
  }
}

function mssqlConfig(database) {
  return {
    server: "127.0.0.1",
    port: 51433,
    user: "sa",
    password: "E2e_Pass_123!",
    database,
    options: { encrypt: false, trustServerCertificate: true },
  };
}

async function connectMssql(database) {
  return retry(async () => {
    const pool = new mssql.ConnectionPool(mssqlConfig(database));
    try {
      return await pool.connect();
    } catch (error) {
      await pool.close().catch(() => {});
      throw error;
    }
  }, 90000);
}

async function seedMssql() {
  const batches = fs
    .readFileSync(path.join(root, "e2e/seed/mssql.sql"), "utf8")
    .split(/^GO$/gm)
    .map((batch) => batch.trim())
    .filter(Boolean);

  const master = await connectMssql("master");
  try {
    await master.request().batch(batches[0]);
  } finally {
    await master.close();
  }

  const gamma = await connectMssql("gamma_db");
  try {
    for (const batch of batches.slice(1)) await gamma.request().batch(batch);
    const result = await gamma.request().query("SELECT COUNT(*) AS count FROM customers");
    return result.recordset[0].count;
  } finally {
    await gamma.close();
  }
}

async function main() {
  const postgres = await seedPostgres();
  const mysqlCount = await seedMysql();
  const mssqlCount = await seedMssql();
  console.log(`SEED_OK postgres=${postgres} mysql=${mysqlCount} mssql=${mssqlCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
