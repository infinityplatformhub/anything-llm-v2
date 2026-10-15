const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const IMAGE =
  "amazon/aws-cli@sha256:139b443e972ace68c8a6404b3558d2033903d7468efce71b6431dd126c6a6371";

function createR2Transport({
  credentialsFile,
  endpoint,
  bucket,
  runner = spawnSync,
}) {
  if (
    bucket !== "anything-llm-backup" ||
    !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint || "")
  )
    throw new Error(
      "R2 destination does not match the approved backup destination."
    );
  const credentials = fs.lstatSync(credentialsFile);
  if (!credentials.isFile() || credentials.mode & 0o077)
    throw new Error("R2 credentials require a protected regular file.");
  const mountedCredentials = path.resolve(credentialsFile);
  if (mountedCredentials.includes(","))
    throw new Error("Unsupported credential mount path.");

  function key(object) {
    if (
      typeof object !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9/_-]*(?:\.enc)?$/.test(object) ||
      object.includes("..")
    )
      throw new Error("Invalid recovery object path.");
  }

  function execute(operation, args, mount) {
    const command = [
      "run",
      "--rm",
      "--pull=never",
      "--platform",
      "linux/arm64",
      "--mount",
      `type=bind,source=${mountedCredentials},target=/protected/credentials,readonly`,
      "--env",
      "AWS_SHARED_CREDENTIALS_FILE=/protected/credentials",
      "--env",
      "AWS_EC2_METADATA_DISABLED=true",
      "--env",
      "AWS_DEFAULT_REGION=auto",
    ];
    if (mount) command.push("--mount", mount);
    command.push(
      IMAGE,
      "--endpoint-url",
      endpoint,
      "--no-cli-pager",
      "s3api",
      operation,
      "--bucket",
      bucket,
      ...args
    );
    let result;
    try {
      result = runner("docker", command, {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: Object.fromEntries(
          ["PATH", "HOME", "TMPDIR"]
            .filter((name) => process.env[name])
            .map((name) => [name, process.env[name]])
        ),
      });
    } catch {
      throw new Error("R2 operation failed; no completion claim was made.");
    }
    if (result.status !== 0 || result.error)
      throw new Error("R2 operation failed; no completion claim was made.");
    return result.stdout;
  }

  return {
    async exists(object) {
      key(object);
      const result = JSON.parse(
        execute("list-objects-v2", ["--prefix", object, "--output", "json"])
      );
      if (!Array.isArray(result.Contents) && result.Contents !== undefined)
        throw new Error("Invalid R2 existence response.");
      return (result.Contents || []).some((entry) => entry.Key === object);
    },
    async put(object, source) {
      key(object);
      const file = path.resolve(source);
      if (file.includes(",") || !fs.lstatSync(file).isFile())
        throw new Error("Invalid encrypted payload path.");
      // Conditional PUT prevents TOCTOU overwrite after prefix checks.
      execute(
        "put-object",
        ["--key", object, "--body", "/payload", "--if-none-match", "*"],
        `type=bind,source=${file},target=/payload,readonly`
      );
    },
    async get(object, destination) {
      key(object);
      const file = path.resolve(destination);
      if (file.includes(",") || fs.existsSync(file))
        throw new Error("Download destination must be fresh.");
      const directory = path.dirname(file);
      const name = path.basename(file);
      execute(
        "get-object",
        ["--key", object, "/download/" + name],
        `type=bind,source=${directory},target=/download`
      );
      if (!fs.lstatSync(file).isFile())
        throw new Error("R2 download did not produce a payload.");
      fs.chmodSync(file, 0o600);
    },
  };
}

module.exports = { createR2Transport };
