const { E2E_A_URL } = require("../lib/env");

test("ping A", async () => {
  const response = await fetch(`${E2E_A_URL}/api/ping`);
  expect(response.ok).toBe(true);
});
