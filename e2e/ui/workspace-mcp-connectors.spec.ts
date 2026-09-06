import fs from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

let auth;
test.beforeAll(() => {
  const authFile = process.env.MCP_UI_AUTH_FILE;
  if (!authFile) throw new Error("Run bash e2e/scripts/run-mcp-ui.sh to create isolated authentication fixtures.");
  auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
});
const settings = (slug: string) => `/workspace/${slug}/settings/agent-config`;
const section = (page: Page) => page.getByRole("region", { name: "MCP Connectors" });
const toggle = (page: Page) => section(page).getByRole("checkbox", { name: /Enable flowaccount in this workspace/ });

async function authenticate(page: Page, role: "admin" | "viewer") {
  // Scoped to the app origin. Never put app credentials on the consent origin.
  await page.context().addInitScript(({ session, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("anythingllm_authToken", session.token);
    localStorage.setItem("anythingllm_user", JSON.stringify(session.user));
  }, { session: auth[role], origin: "http://localhost:3020" });
}
async function rendered(page: Page) {
  await expect(section(page).getByRole("heading", { name: "flowaccount", exact: true })).toBeVisible();
  await expect(section(page)).toHaveAttribute("aria-busy", "false");
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  if (await section(page).isVisible()) await section(page).scrollIntoViewIfNeeded();
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(name, { path: file, contentType: "image/png" });
}

test("workspace OAuth connection, persistence, isolation, and disconnect", async ({ page }, info) => {
  await authenticate(page, "admin");
  await test.step("01 disconnected connector has guarded toggle", async () => {
    await page.goto(settings("ws-alpha"));
    await rendered(page);
    await expect(section(page).getByText("Not connected", { exact: true })).toBeVisible();
    await expect(toggle(page)).toBeDisabled();
    await expect(toggle(page)).not.toBeChecked();
    await screenshot(page, info, "01-disconnected");
  });

  await test.step("02 real OAuth consent returns connected status", async () => {
    // Product uses window.location.assign, not a popup.
    await section(page).getByRole("button", { name: "Connect flowaccount", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect company" })).toBeVisible();
    await expect(page.getByText("LOCAL TEST PROVIDER · NOT FLOWACCOUNT")).toBeVisible();
    await page.getByLabel("Company", { exact: true }).selectOption("Alpha Company");
    await screenshot(page, info, "02a-consent");
    const callback = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/oauth/callback");
    await page.getByRole("button", { name: "FlowAccount (fake) — Allow", exact: true }).click();
    const response = await callback;
    expect(response.status()).toBe(302);
    const destination = response.headers().location;
    expect(destination).toContain("connected=1");
    await page.waitForURL((url) => url.origin === "http://localhost:3020" && url.pathname === settings("ws-alpha"));
    info.annotations.push({ type: "harness-note", description: "API callback uses a relative redirect, like Lark login. Test-only gateway redirects /workspace/* to Vite; no browser navigation workaround or product edits." });
    await rendered(page);
    await expect(section(page).getByText("Connected", { exact: true })).toBeVisible();
    await expect(section(page).getByText(/Access token expires in \d+:\d{2}/)).toBeVisible();
    await expect(toggle(page)).toBeEnabled();
    await expect(toggle(page)).toBeChecked();
    await screenshot(page, info, "02-connected");
  });

  await test.step("03 user toggles off and on and reload persists", async () => {
    await rendered(page);
    await expect(toggle(page)).toBeChecked();
    const disabled = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/workspace/ws-alpha/mcp/toggle"));
    await section(page).getByText("Enable flowaccount in this workspace", { exact: true }).click();
    expect((await disabled).status()).toBe(200);
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeEnabled();
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/workspace/ws-alpha/mcp/toggle"));
    await section(page).getByText("Enable flowaccount in this workspace", { exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(toggle(page)).toBeChecked();
    await expect(toggle(page)).toBeEnabled();
    await page.reload();
    await rendered(page);
    await expect(toggle(page)).toBeChecked();
    await screenshot(page, info, "03-enabled");
  });

  await test.step("04 beta remains disconnected", async () => {
    await page.goto(settings("ws-beta"));
    await rendered(page);
    await expect(section(page).getByText("Workspace: ws-beta", { exact: true })).toBeVisible();
    await expect(section(page).getByText("Not connected", { exact: true })).toBeVisible();
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeDisabled();
    await screenshot(page, info, "04-beta-isolated");
  });

  await test.step("05 alpha disconnect clears tokens and enabled state", async () => {
    await page.goto(settings("ws-alpha"));
    await rendered(page);
    await expect(section(page).getByText("Connected", { exact: true })).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());
    await section(page).getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(section(page).getByText("Not connected", { exact: true })).toBeVisible();
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeDisabled();
    await page.reload();
    await rendered(page);
    await expect(section(page).getByText("Not connected", { exact: true })).toBeVisible();
    await expect(toggle(page)).not.toBeChecked();
    await expect(toggle(page)).toBeDisabled();
    await screenshot(page, info, "05-disconnected-again");
  });
});

test("manager workspace member sees read-only connectors", async ({ page, request }, info) => {
  expect(auth.viewer.user.role).toBe("manager");
  const membership = await request.get("http://localhost:3021/api/workspaces", { headers: { Authorization: `Bearer ${auth.viewer.token}` } });
  expect(membership.ok()).toBe(true);
  expect((await membership.json()).workspaces.map((workspace: { slug: string }) => workspace.slug)).toContain("ws-alpha");

  const adminHeaders = { Authorization: `Bearer ${auth.admin.token}` };
  const start = await request.get("http://localhost:3021/api/mcp/oauth/start/ws-alpha/flowaccount", { headers: adminHeaders });
  expect(start.ok()).toBe(true);
  const authorizeUrl = new URL((await start.json()).url);
  authorizeUrl.searchParams.set("company", "Alpha Company");
  authorizeUrl.searchParams.set("allow", "1");
  const consent = await request.get(authorizeUrl.href, { maxRedirects: 0 });
  expect(consent.status()).toBe(302);
  const callbackUrl = consent.headers().location;
  if (!callbackUrl) throw new Error("Fake provider authorization did not redirect to OAuth callback");
  const callback = await request.get(callbackUrl, { maxRedirects: 0 });
  expect(callback.status()).toBe(302);
  expect(callback.headers().location).toContain("connected=1");

  await authenticate(page, "viewer");
  const reads = Promise.all([
    page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/mcp-servers/list")),
    page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/workspace/ws-alpha/mcp"),
  ]);
  await page.goto(settings("ws-alpha"));
  const responses = await reads;
  await expect(section(page).getByRole("heading", { name: "MCP Connectors", exact: true })).toBeVisible();
  await expect(section(page)).toHaveAttribute("aria-busy", "false");
  await screenshot(page, info, "06-viewer");
  await info.attach("manager-mcp-read-statuses", { body: JSON.stringify(responses.map((response) => ({ url: response.url(), status: response.status() })), null, 2), contentType: "application/json" });
  for (const response of responses) expect(response.status(), `Manager read access: ${response.url()}`).toBe(200);
  await rendered(page);
  await expect(section(page).getByText(/Read-only view\. Only administrators/)).toBeVisible();
  await expect(toggle(page)).toBeDisabled();
  await expect(section(page).getByRole("button", { name: "Disconnect", exact: true })).toBeDisabled();
  await screenshot(page, info, "06-viewer");
});
