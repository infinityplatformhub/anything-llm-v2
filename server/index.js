process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

// Endpoint imports can start timers, create keys and initialize integrations.
// Load none of them until the PG runtime passes the read-only readiness check.
const { startAfterDatabase } = require("./utils/prisma/startup");
startAfterDatabase(() => require("./app")).catch(async () => {
  console.error(
    "Application startup failed; check database configuration and readiness."
  );
  try {
    await require("./utils/prisma").$disconnect();
  } catch {
    // Never print potentially credential-bearing connection errors.
  }
  process.exit(1);
});
