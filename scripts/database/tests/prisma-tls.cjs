const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function verifyPrismaTls({ id, client, port }) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-prisma-tls-")
  );
  const openssl = (args) =>
    execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  const {
    PrismaClient,
  } = require("../../../server/generated/prisma-postgresql");
  let preserve = false;
  try {
    // SAN matches 127.0.0.1 only; localhost is the negative hostname probe.
    fs.writeFileSync(
      path.join(root, "request.cnf"),
      `[req]\ndistinguished_name=dn\nreq_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`
    );
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-days",
      "1",
      "-subj",
      "/CN=Synthetic-fixture-CA",
    ]);
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-config",
      "request.cnf",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.crt",
      "-days",
      "1",
      "-extfile",
      "request.cnf",
      "-extensions",
      "ext",
    ]);
    openssl([
      "verify",
      "-CAfile",
      "ca.crt",
      "-verify_ip",
      "127.0.0.1",
      "server.crt",
    ]);
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "wrong.key",
      "-out",
      "wrong.crt",
      "-days",
      "1",
      "-subj",
      "/CN=Wrong-synthetic-CA",
    ]);
    // docker cp can target the underlying layer instead of this tmpfs. Write
    // fixture PEM through stdin inside the running mount, never CLI arguments.
    for (const file of ["server.key", "server.crt"])
      execFileSync(
        "docker",
        [
          "exec",
          "--interactive",
          "--user",
          "root",
          id,
          "sh",
          "-c",
          `cat > /var/lib/postgresql/data/${file}`,
        ],
        {
          input: fs.readFileSync(path.join(root, file)),
          stdio: ["pipe", "ignore", "pipe"],
        }
      );
    execFileSync(
      "docker",
      [
        "exec",
        "--user",
        "root",
        id,
        "sh",
        "-c",
        "chown postgres:postgres /var/lib/postgresql/data/server.key /var/lib/postgresql/data/server.crt && chmod 600 /var/lib/postgresql/data/server.key",
      ],
      { encoding: "utf8" }
    );
    await client.query("ALTER SYSTEM SET ssl='on'");
    await client.query(
      "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/data/server.crt'"
    );
    await client.query(
      "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/data/server.key'"
    );
    await client.query("SELECT pg_reload_conf()");
    // Existing non-TLS fixture clients remain connected; new sessions use TLS.
    async function probe(host, certificate) {
      const url = new URL(
        `postgresql://anythingllm_app:synthetic-runtime@${host}:${port}/fixture`
      );
      url.searchParams.set("sslmode", "require");
      url.searchParams.set("sslaccept", "strict");
      url.searchParams.set("sslcert", path.join(root, certificate));
      url.searchParams.set("connect_timeout", "3");
      const prisma = new PrismaClient({
        datasources: { db: { url: url.toString() } },
      });
      try {
        return await prisma.$queryRawUnsafe(
          "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"
        );
      } finally {
        await prisma.$disconnect();
      }
    }
    // Reload completion is established by the actual TLS positive probe. Never
    // relax sslaccept or treat a failed trust check as a readiness success.
    const secure = await probe("127.0.0.1", "ca.crt");
    assert.equal(secure[0].ssl, true);
    await assert.rejects(probe("127.0.0.1", "wrong.crt"));
    await assert.rejects(probe("localhost", "ca.crt"));
    const url = new URL(
      `postgresql://anythingllm_app:synthetic-runtime@127.0.0.1:${port}/fixture`
    );
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("sslaccept", "strict");
    url.searchParams.set("sslcert", path.join(root, "ca.crt"));
    url.searchParams.set("connection_limit", "5");
    preserve = true;
    return {
      url: url.toString(),
      caFile: path.join(root, "ca.crt"),
      certificateFile: path.join(root, "server.crt"),
      keyFile: path.join(root, "server.key"),
      cleanup: () => fs.rmSync(root, { recursive: true }),
    };
  } finally {
    if (!preserve) fs.rmSync(root, { recursive: true });
  }
}

module.exports = { verifyPrismaTls };
