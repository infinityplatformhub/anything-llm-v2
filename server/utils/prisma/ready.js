// Container gate runs before either server or collector starts.
require("dotenv").config();
require("./startup")
  .verifyRuntimeDatabase()
  .then(async () => {
    if (require("./artifact.json").provider === "postgresql") {
      await require("./index").$disconnect();
    }
  })
  .catch(async () => {
    console.error(
      "Database readiness failed; server and collector were not started."
    );
    try {
      await require("./index").$disconnect();
    } catch {}
    process.exit(1);
  });
