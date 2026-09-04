const fs = require("fs"); const path = require("path");
const mark = (logFile) => fs.statSync(logFile).size;
const since = (logFile, m) => fs.readFileSync(logFile, "utf8").slice(m);
const attached = (chunk, name) => chunk.includes(`Attached ${name} plugin to Agent cluster`) || chunk.includes(`Attached ${name}:`);
const toolCalled = (chunk, tool) => chunk.includes(`is attempting to call \`${tool}\` tool`);
const attachedAny = (chunk) => (chunk.match(/Attached (\S+) plugin to Agent cluster/g) || []).map((s) => s.replace(/Attached (\S+) plugin.*/, "$1")).filter((n) => n !== "httpSocket");
const files = (dir, re) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)) : [];
async function pgCount(url) { const { Client } = require("../../server/node_modules/pg"); const c = new Client(url); await c.connect(); const r = await c.query("select count(*)::int as n from customers"); await c.end(); return r.rows[0].n; }
async function mysqlCount(url) { const m = require("../../server/node_modules/mysql2/promise"); const c = await m.createConnection(url); const [r] = await c.query("select count(*) as n from customers"); await c.end(); return Number(r[0].n); }
async function mssqlCount(cfg) { const s = require("../../server/node_modules/mssql"); const p = await s.connect(cfg); const r = await p.request().query("select count(*) as n from customers"); await p.close(); return r.recordset[0].n; }
module.exports = { mark, since, attached, toolCalled, attachedAny, files, pgCount, mysqlCount, mssqlCount };
