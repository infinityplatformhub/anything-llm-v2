const path = require("path");
const { execFileSync } = require("child_process");
const root = path.resolve(__dirname, "../../..");
const eslint = path.join(root, "server/node_modules/eslint/lib/api.js");

function lint(source, filePath) {
  const script = `import { ESLint } from ${JSON.stringify(eslint)};
    const linter = new ESLint({ cwd: ${JSON.stringify(root)} });
    const result = await linter.lintText(${JSON.stringify(source)}, { filePath: ${JSON.stringify(filePath)} });
    console.log(JSON.stringify(result[0].messages));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
    })
  );
}

it("checks backend JavaScript without applying React component rules", () => {
  const messages = lint(
    "module.exports = function () { return undefinedBackendName; };",
    "server/utils/fixture.js"
  );
  expect(messages.some((m) => m.ruleId === "no-undef")).toBe(true);
  expect(messages.some((m) => m.ruleId?.startsWith("react"))).toBe(false);
});

it("still catches unsafe frontend links and conditional hooks", () => {
  const messages = lint(
    'import { useState } from "react"; export default function Fixture() { if (Math.random()) useState(0); return <a href="https://example.com" target="_blank">Link</a>; }',
    "frontend/src/Fixture.jsx"
  );
  expect(
    messages.some(
      (m) => m.ruleId === "react/jsx-no-target-blank" && m.severity === 2
    )
  ).toBe(true);
  expect(
    messages.some(
      (m) => m.ruleId === "react-hooks/rules-of-hooks" && m.severity === 2
    )
  ).toBe(true);
});
