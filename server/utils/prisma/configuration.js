/**
 * Validate explicit configuration against the client built into the artifact.
 * No process environment, dotenv, filesystem or database access occurs here.
 * A null URL means retaining the existing SQLite schema-defined datasource.
 */
function resolveDatabaseConfiguration(
  configuration = {},
  artifact = { provider: "sqlite" }
) {
  const provider = configuration.ANYTHINGLLM_DATABASE_PROVIDER ?? "sqlite";
  if (provider !== "sqlite" && provider !== "postgresql") {
    throw new Error("Unsupported database provider.");
  }
  if (
    !artifact ||
    (artifact.provider !== "sqlite" && artifact.provider !== "postgresql")
  ) {
    throw new Error("Unsupported database artifact provider.");
  }
  if (provider !== artifact.provider) {
    throw new Error("Database configuration does not match the built client.");
  }

  const url = configuration.ANYTHINGLLM_DATABASE_URL;
  if (provider === "sqlite") {
    if (url === undefined || url === null) return { provider, url: null };
    if (
      typeof url !== "string" ||
      !url.startsWith("file:") ||
      url.length <= 5
    ) {
      throw new Error("SQLite requires a nonempty file datasource URL.");
    }
    return { provider, url };
  }

  if (typeof url !== "string" || !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new Error(
      "PostgreSQL requires an explicit PostgreSQL datasource URL."
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Native URL exceptions can contain credentials; do not retain their cause.
    throw new Error("Invalid PostgreSQL datasource URL.");
  }
  if (!parsed.hostname || parsed.pathname.length <= 1) {
    throw new Error("PostgreSQL requires a host and database name.");
  }
  return { provider, url };
}

module.exports = { resolveDatabaseConfiguration };
