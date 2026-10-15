const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function protectedFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error("A protected regular request/credential file is required.");
  return file;
}

async function main() {
  const [command, flag, requestPath] = process.argv.slice(2);
  if (command === "--help" && process.argv.length === 3) {
    console.log(
      "Commands: contract | capture | export | import | verify | publish | restore | restore-storage\nOperations require --request <0600 JSON file>. Never supply a credential URL as a CLI argument.\nProduction operations require approved readiness/freeze/cutover evidence; this CLI does not grant authority."
    );
    return;
  }
  if (command === "contract" && process.argv.length === 3) {
    const models = require("../../server/generated/prisma-postgresql").Prisma
      .dmmf.datamodel.models;
    console.log(
      JSON.stringify(
        require("./schema-contract.cjs").createSchemaContract(models)
      )
    );
    return;
  }
  if (
    ![
      "capture",
      "export",
      "import",
      "verify",
      "publish",
      "restore",
      "restore-storage",
    ].includes(command) ||
    flag !== "--request" ||
    process.argv.length !== 5
  )
    throw new Error(
      "Use an explicit operation with --request and a protected request file."
    );
  protectedFile(requestPath);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (["capture", "export", "restore-storage"].includes(command)) {
    const env = {
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]])
      ),
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const result = spawnSync(
      "python3",
      [path.join(__dirname, "offline.py"), command, path.resolve(requestPath)],
      { env, encoding: "utf8" }
    );
    if (result.status !== 0)
      throw new Error("Offline operation failed; inspect protected evidence.");
    process.stdout.write(result.stdout);
    return;
  }
  if (["import", "verify"].includes(command)) {
    const { Client } = require("../../server/node_modules/pg");
    const client = new Client(
      require("./maintenance-connection.cjs").maintenanceConnection(request)
    );
    try {
      await client.connect();
      const result =
        command === "import"
          ? await require("./import.cjs").importSnapshot(client, request)
          : await require("./verify.cjs").verifySnapshot(client, request);
      console.log(JSON.stringify(result));
    } finally {
      await client.end();
    }
    return;
  }
  const key = fs.readFileSync(protectedFile(request.keyFile));
  const transport = require("./r2.cjs").createR2Transport({
    credentialsFile: request.credentialsFile,
    endpoint: request.endpoint,
    bucket: request.bucket,
  });
  const operation =
    command === "publish"
      ? require("./publication.cjs").publishRecoverySet
      : require("./publication.cjs").restoreRecoverySet;
  console.log(JSON.stringify(await operation(transport, { ...request, key })));
}

main().catch(() => {
  console.error(
    "Migration command failed: protected request validation or operation failed. No completion claim; inspect protected evidence."
  );
  process.exitCode = 1;
});
