const fs = require("node:fs");

function maintenanceConnection(request) {
  try {
    const file = fs.lstatSync(request.connectionFile);
    if (
      !file.isFile() ||
      file.mode & 0o077 ||
      !request.caFile ||
      !fs.lstatSync(request.caFile).isFile()
    )
      throw new Error();
    const url = new URL(fs.readFileSync(request.connectionFile, "utf8").trim());
    const target = request.target;
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const port = Number(url.port || "5432");
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      url.search ||
      url.hash ||
      !url.hostname ||
      !database ||
      !url.password ||
      !target ||
      target.host !== url.hostname ||
      target.port !== port ||
      target.database !== database ||
      target.role !== user ||
      target.schema !== "public" ||
      user !== "anythingllm_migrator"
    )
      throw new Error();
    return {
      host: url.hostname,
      port,
      database,
      user,
      password: decodeURIComponent(url.password),
      ssl: {
        ca: fs.readFileSync(request.caFile, "utf8"),
        rejectUnauthorized: true,
      },
      connectionTimeoutMillis: 10000,
    };
  } catch {
    throw new Error(
      "Protected maintenance connection or TLS target identity is invalid."
    );
  }
}

module.exports = { maintenanceConnection };
