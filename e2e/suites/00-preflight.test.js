const { E2E_A_URL, E2E_B_URL, AIG_API_KEY } = require("../lib/env");
const { ping, setupComplete } = require("../lib/api");
const { pgCount, mysqlCount, mssqlCount } = require("../lib/evidence");

describe("preflight", () => {
  test("gateway accepts tool-enabled chat", async () => {
    const response = await fetch("https://aig.infinityplatform.tech/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIG_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "aix-qwen3.8-flash-next",
        messages: [{ role: "user", content: "Reply OK." }],
        tools: [{
          type: "function",
          function: {
            name: "noop",
            description: "No-op test function",
            parameters: { type: "object", properties: {} },
          },
        }],
        max_tokens: 10,
      }),
    });
    expect(response.status).toBe(200);
  });

  test("servers A and B respond", async () => {
    await expect(ping(E2E_A_URL)).resolves.toMatchObject({ status: 200 });
    await expect(ping(E2E_B_URL)).resolves.toMatchObject({ status: 200 });
  });

  test("server A uses generic OpenAI", async () => {
    const response = await setupComplete(E2E_A_URL);
    expect(response.body.results.LLMProvider).toBe("generic-openai");
  });

  test("seeded databases each contain three customers", async () => {
    await expect(pgCount("postgres://e2e:e2epass@localhost:55432/alpha_db")).resolves.toBe(3);
    await expect(mysqlCount("mysql://e2e:e2epass@localhost:53306/beta_db")).resolves.toBe(3);
    await expect(mssqlCount({
      server: "localhost",
      port: 51433,
      user: "sa",
      password: "E2e_Pass_123!",
      database: "gamma_db",
      options: { encrypt: false, trustServerCertificate: true },
    })).resolves.toBe(3);
  });

  test("collector responds", async () => {
    const response = await fetch("http://localhost:8888");
    expect(response.status).toBeLessThan(500);
  });

  test("fixture web serves marker", async () => {
    const response = await fetch("http://localhost:58080/page.html");
    expect(await response.text()).toContain("FIXTURE-WEB-MARKER-5150");
  });
});
