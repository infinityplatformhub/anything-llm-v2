// Dev-only: regenerate the pinned Drive/Base read pairs from CLI --help.
const { execFileSync } = require("child_process");

const binary = process.env.LARK_CLI_PATH || ["lark", "cli"].join("-");
const mutating =
  /(^|-)(create|update|delete|upsert|submit|upload|move|rename|set|enable|disable|revert|restore|remove|add|bind|unbind|arrange)(-|$)|share-update/;
const help = (...args) =>
  execFileSync(binary, [...args, "--help"], {
    encoding: "utf8",
    timeout: 10_000,
  });
const pairs = [];
for (const group of ["drive", "base"]) {
  const subs = [...help(group).matchAll(/^\s+(\+[a-z][a-z0-9_-]*)\s/gm)].map(
    (match) => match[1]
  );
  if (!subs.length) throw new Error(`No shortcut commands found for ${group}`);
  for (const sub of new Set(subs)) {
    if (sub.includes("_")) continue;
    if (!/Risk:\s*read\b/.test(help(group, sub))) continue;
    const segments = sub.slice(1).split("-");
    if (
      mutating.test(sub.slice(1)) ||
      (segments.includes("copy") && segments.at(-1) !== "status")
    ) {
      console.error(`Excluded mutating read pair: ${group} ${sub}`);
      continue;
    }
    pairs.push(`${group} ${sub}`);
  }
}
console.log(JSON.stringify(pairs.sort(), null, 2));
