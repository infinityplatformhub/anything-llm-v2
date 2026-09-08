import fs from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

let auth;
const name = "workspace-erp";
const mask = "••••••••";
const catalogPath = "/api/workspace/ws-alpha/mcp-servers";
const section = (page: Page) => page.getByRole("region", { name: "MCP Connectors" });
const card = (page: Page, serverName = name) => section(page).getByRole("article").filter({
  has: page.getByRole("heading", { name: serverName, exact: true }),
});

test.beforeAll(() => {
  const file = process.env.MCP_UI_AUTH_FILE;
  if (!file) throw new Error("Run bash e2e/scripts/run-mcp-servers-ui.sh for isolated services and authentication.");
  auth = JSON.parse(fs.readFileSync(file, "utf8"));
});

async function open(page: Page, role: "admin" | "viewer" = "admin") {
  await page.context().addInitScript(({ session, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("anythingllm_authToken", session.token);
    localStorage.setItem("anythingllm_user", JSON.stringify(session.user));
  }, { session: auth[role], origin: "http://localhost:3020" });
  await page.goto("/workspace/ws-alpha/settings/agent-config");
  await expect(section(page)).toHaveAttribute("aria-busy", "false");
  await expect(card(page, "flowaccount").getByText("Shared globally", { exact: true })).toBeVisible();
}
async function manage(page: Page, action: string) {
  await card(page).getByRole("button", { name: `Manage ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  if (!(await page.getByRole("dialog").count())) await section(page).scrollIntoViewIfNeeded();
  const file = info.outputPath(`${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(label, { path: file, contentType: "image/png" });
}

// One lifecycle, one isolated seeded workspace. A failed prerequisite skips dependents,
// which the gate rejects instead of letting later tests fabricate missing state.
test.describe.serial("workspace MCP server management", () => {
  test("admin adds a bearer server through Form, probes, and saves an owned card", async ({ page }, info) => {
    await open(page);
    await test.step("01 Form config probes the real bearer MCP endpoint", async () => {
      await section(page).getByRole("button", { name: "Add MCP server", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "Add MCP server", exact: true });
      await expect(modal.getByRole("tab", { name: "Form", exact: true })).toHaveAttribute("aria-selected", "true");
      await modal.getByLabel("Server name", { exact: true }).fill(name);
      await modal.getByLabel("URL", { exact: true }).fill(auth.plain.url);
      await modal.getByLabel("Transport", { exact: true }).selectOption("http");
      await modal.getByRole("button", { name: "Add header", exact: true }).click();
      await modal.getByLabel("Header key 1", { exact: true }).fill("Authorization");
      await modal.getByLabel("Header value 1", { exact: true }).fill(`Bearer ${auth.plain.token}`);
      await expect(modal.getByLabel("Header value 1", { exact: true })).toHaveAttribute("type", "password");
      await modal.getByRole("button", { name: "Test connection", exact: true }).click();
      await expect(modal.getByText(/^Connected · 2 tools · \d+ ms$/)).toBeVisible();
      await screenshot(page, info, "01-form-probe");
      const saved = page.waitForResponse((res) => new URL(res.url()).pathname === catalogPath && res.request().method() === "POST");
      await modal.getByRole("button", { name: "Save", exact: true }).click();
      expect((await saved).status()).toBe(201);
      await expect(modal).not.toBeVisible();
      await expect(card(page).getByText("Workspace-owned", { exact: true })).toBeVisible();
      await expect(card(page).getByText(mask, { exact: true })).toBeVisible();
      await screenshot(page, info, "01-owned-card");
    });
  });

  test("admin enables saved server and runs get_company with raw result and latency", async ({ page }, info) => {
    await open(page);
    await test.step("02 allowlist toggle enables a real no-argument call", async () => {
      const toggle = card(page).getByRole("checkbox", { name: `Enable ${name} in this workspace`, exact: true });
      await expect(toggle).not.toBeChecked();
      await card(page).getByText(`Enable ${name} in this workspace`, { exact: true }).click();
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeEnabled();
      await manage(page, "Test tools");
      const modal = page.getByRole("dialog", { name: `Test tools · ${name}`, exact: true });
      await modal.getByLabel("Choose tool", { exact: true }).selectOption("get_company");
      await expect(modal.getByText("This tool does not require arguments.", { exact: true })).toBeVisible();
      await modal.getByRole("button", { name: "Run", exact: true }).click();
      const result = modal.getByRole("region", { name: "Raw result", exact: true });
      await expect(result.locator("pre")).toContainText("Workspace Company");
      await expect(result.getByText(/^Raw result · \d+ ms$/)).toBeVisible();
      expect(JSON.parse(await result.locator("pre").innerText()).content).toEqual([{ type: "text", text: "Workspace Company" }]);
      await screenshot(page, info, "02-company-result");
    });
  });

  test("@edge object argument rejects invalid JSON and runs create_invoice with an object", async ({ page }, info) => {
    await open(page);
    await manage(page, "Test tools");
    const modal = page.getByRole("dialog", { name: `Test tools · ${name}`, exact: true });
    await modal.getByLabel("Choose tool", { exact: true }).selectOption("create_invoice");
    const argument = modal.getByLabel("invoice *", { exact: true });
    await expect(argument).toHaveAttribute("required", "");
    await argument.fill("not JSON");
    await modal.getByRole("button", { name: "Run", exact: true }).click();
    await expect(modal.getByRole("alert")).toHaveText("invoice must contain valid JSON.");
    const invoice = { customer: "E2E customer", amount: 42 };
    await argument.fill(JSON.stringify(invoice));
    const called = page.waitForResponse((res) => new URL(res.url()).pathname === `${catalogPath}/${name}/call`);
    await modal.getByRole("button", { name: "Run", exact: true }).click();
    const response = await called;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ toolName: "create_invoice", arguments: { invoice } });
    const result = modal.getByRole("region", { name: "Raw result", exact: true });
    await expect(result.locator("pre")).toContainText("E2E customer");
    const raw = JSON.parse(await result.locator("pre").innerText());
    expect(JSON.parse(raw.content[0].text)).toEqual({ status: "created", invoice });
    await screenshot(page, info, "03-invoice-object-result");
  });

  test("@edge JSON stdio command, args, and env name offending key and disable Save", async ({ page }, info) => {
    await open(page);
    await section(page).getByRole("button", { name: "Add MCP server", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Add MCP server", exact: true });
    await modal.getByRole("tab", { name: "JSON", exact: true }).click();
    for (const [key, value] of Object.entries({ command: "node", args: ["server.js"], env: { TEST: "value" } })) {
      await test.step(`04 reject local stdio field ${key}`, async () => {
        await modal.getByLabel("MCP server JSON", { exact: true }).fill(JSON.stringify({ mcpServers: { rejected: { url: auth.plain.url, type: "http", [key]: value } } }));
        await expect(modal.getByRole("alert")).toHaveText(`Workspace servers do not support stdio. Remove the command, args, or env field and configure local servers globally. Offending field: ${key}`);
        await expect(modal.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await expect(modal.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
      });
    }
    await screenshot(page, info, "04-stdio-rejected");
  });

  test("@edge unchanged masked Authorization survives edit and saved-name probe", async ({ page }, info) => {
    await open(page);
    await manage(page, "Edit");
    let modal = page.getByRole("dialog", { name: `Edit ${name}`, exact: true });
    await expect(modal.getByLabel("Header value 1", { exact: true })).toHaveValue(mask);
    await expect(modal.getByLabel("Header value 1", { exact: true })).toHaveAttribute("type", "password");
    await screenshot(page, info, "05-masked-edit");
    const saved = page.waitForResponse((res) => new URL(res.url()).pathname === `${catalogPath}/${name}` && res.request().method() === "PUT");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    const response = await saved;
    expect(response.request().postDataJSON().config.headers.Authorization).toBe(mask);
    expect(response.status()).toBe(200);
    await expect(modal).not.toBeVisible();
    await manage(page, "Edit");
    modal = page.getByRole("dialog", { name: `Edit ${name}`, exact: true });
    const probed = page.waitForResponse((res) => new URL(res.url()).pathname === `${catalogPath}/test`);
    await modal.getByRole("button", { name: "Test connection", exact: true }).click();
    const probe = await probed;
    expect(probe.request().postDataJSON()).toEqual({ name });
    expect(probe.status()).toBe(200);
    await expect(modal.getByText(/^Connected · 2 tools · \d+ ms$/)).toBeVisible();
    await screenshot(page, info, "05-saved-secret-probe");
  });

  test("manager member sees read-only owned and global cards without credentials or manage controls", async ({ page }, info) => {
    expect(auth.viewer.user.role).toBe("manager");
    const read = page.waitForResponse((res) => new URL(res.url()).pathname === catalogPath && res.request().method() === "GET");
    await open(page, "viewer");
    const response = await read;
    expect(response.status()).toBe(200);
    const servers = (await response.json()).servers;
    expect(servers.find((server) => server.name === name).config).toEqual({
      anythingllm: { perWorkspaceAuth: false, suppressedTools: [] },
    });
    for (const server of servers) {
      expect(server.config).not.toHaveProperty("headers");
      expect(server.config).not.toHaveProperty("url");
    }
    await expect(card(page).getByText("Workspace-owned", { exact: true })).toBeVisible();
    await expect(section(page).getByText(mask, { exact: true })).toHaveCount(0);
    await expect(section(page).getByText("Authorization:", { exact: true })).toHaveCount(0);
    await expect(section(page).getByText(auth.plain.url, { exact: false })).toHaveCount(0);
    await expect(section(page).getByText(/^Read-only view\. Only administrators/)).toBeVisible();
    await expect(section(page).getByRole("button")).toHaveCount(0);
    await expect(section(page).getByRole("menuitem")).toHaveCount(0);
    for (const toggle of await section(page).getByRole("checkbox").all()) await expect(toggle).toBeDisabled();
    await screenshot(page, info, "06-manager-read-only");
  });

  test("admin deletes owned server and catalog plus allowlist no longer list it", async ({ page }, info) => {
    await open(page);
    await manage(page, "Delete");
    const modal = page.getByRole("alertdialog", { name: `Delete ${name}?`, exact: true });
    await expect(modal.getByText(/OAuth tokens, and enable state/)).toBeVisible();
    await screenshot(page, info, "07-delete-confirmation");
    await modal.getByRole("button", { name: "Delete server", exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(card(page)).toHaveCount(0);
    const headers = { Authorization: `Bearer ${auth.admin.token}` };
    const catalog = await page.request.get(`http://localhost:3021${catalogPath}`, { headers });
    expect(catalog.status()).toBe(200);
    expect((await catalog.json()).servers.map((server) => server.name)).not.toContain(name);
    const connections = await page.request.get("http://localhost:3021/api/workspace/ws-alpha/mcp", { headers });
    expect(connections.status()).toBe(200);
    expect((await connections.json()).connections.map((connection) => connection.serverName)).not.toContain(name);
    await page.reload();
    await expect(section(page)).toHaveAttribute("aria-busy", "false");
    await expect(card(page)).toHaveCount(0);
    await expect(card(page, "flowaccount")).toBeVisible();
    await screenshot(page, info, "07-deleted");
  });
});
