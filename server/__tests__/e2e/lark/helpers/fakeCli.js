#!/usr/bin/env node
/**
 * Stand-in for the real Lark CLI binary, reached through a generated shim that
 * LARK_CLI_PATH points at. The runner forwards only PATH/LANG/TZ/TMPDIR plus its
 * own LARKSUITE_* vars, so the harness cannot pass a mode through the
 * environment. The shim sets FAKE_CLI_STATE to a JSON file the harness owns;
 * that file carries the mode and where to append invocation records.
 */
const fs = require("fs");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_CLI_STATE, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const state = readState();
  const argv = process.argv.slice(2);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.startsWith("LARKSUITE_CLI_") ||
        key === "HOME" ||
        key === "CI" ||
        key === "PATH"
    )
  );

  if (state.invocationsFile) {
    try {
      fs.appendFileSync(
        state.invocationsFile,
        `${JSON.stringify({ argv, env, at: Date.now() })}\n`
      );
    } catch {}
  }

  const mode = state.mode || "ok";
  const token = process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN || "";

  // No "sleep" mode: the TIMEOUT_MS kill path is proven with fake timers in
  // __tests__/utils/lark/cli.test.js, and a real 60 s wait would only stall
  // this suite.
  if (mode === "fail") {
    process.stderr.write(`fake cli failed while using token ${token}\n`);
    process.exit(2);
  } else if (mode === "big") {
    // Comfortably past MAX_OUTPUT_BYTES (65536) so the runner trips its cap.
    const chunk = "x".repeat(4096);
    for (let index = 0; index < 40; index += 1) process.stdout.write(chunk);
    process.stdout.write("\n");
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ argv, env }));
    process.exit(0);
  }
}

// Only behaves like a binary when spawned as one. Jest collects every file
// under __tests__, and this must not exit the runner when it does.
if (require.main === module) main();
else
  test("is an executable fixture, not a suite", () => {
    expect(typeof main).toBe("function");
  });
