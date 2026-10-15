const http = require("node:http");
const path = require("node:path");
const { chromium, expect: browserExpect } = require("@playwright/test");
const { build } = require("../../../frontend/node_modules/esbuild");

// Regression: personal connections must be reachable from Settings, not a
// floating chat control; opening/closing must preserve OAuth actions.
describe("personal MCP connections in chat Settings", () => {
  let browser, server, origin, page;

  beforeAll(async () => {
    const frontend = path.resolve(__dirname, "../../../frontend");
    const bundle = await build({
      absWorkingDir: frontend,
      stdin: {
        resolveDir: frontend,
        loader: "jsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import i18next from "i18next";
          import { initReactI18next } from "react-i18next";
          import { AuthContext } from "./src/AuthContext";
          import { ChatSidebarProvider } from "./src/components/WorkspaceChat/ChatContainer/ChatSidebar";
          import ChatSettingsMenu from "./src/components/WorkspaceChat/ChatContainer/ChatSettingsMenu";
          i18next.use(initReactI18next).init({ lng: "en", resources: {} });
          createRoot(document.getElementById("root")).render(
            <AuthContext.Provider value={{ store: { user: { id: 7, role: "default" } } }}>
              <ChatSidebarProvider>
                <ChatSettingsMenu workspace={{ slug: "ws-alpha" }} />
              </ChatSidebarProvider>
            </AuthContext.Provider>
          );
        `,
      },
      bundle: true,
      write: false,
      jsx: "automatic",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
      alias: { "@": path.join(frontend, "src") },
      define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
      logLevel: "silent",
    });
    server = http.createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/app.js" ? "text/javascript" : "text/html"
      );
      res.end(
        req.url === "/app.js"
          ? bundle.outputFiles[0].text
          : '<div id="root"></div><script src="/app.js"></script>'
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(4000);
    page.on("pageerror", (error) => {
      throw error;
    });
    await page.route("**/api/system/keys", (route) =>
      route.fulfill({ json: {} })
    );
  });
  afterEach(async () => page?.close());

  async function openSettings() {
    await page.goto(origin);
    expect(
      await page.getByText("My MCP connections", { exact: true }).count()
    ).toBe(0);
    // This is the existing sliders button, the only button before opening.
    await page.getByRole("button").click();
    await page
      .getByRole("button", { name: "My MCP connections", exact: true })
      .click({ timeout: 3000 });
  }

  test("Settings opens the connections dialog and disconnect refreshes account status", async () => {
    let connected = true;
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              name: "flowaccount",
              connected,
              needsReauth: false,
              accountLabel: connected ? "Alpha account" : null,
            },
          ],
        },
      })
    );
    await page.route("**/api/mcp/oauth/disconnect", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        workspaceSlug: "ws-alpha",
        serverName: "flowaccount",
      });
      connected = false;
      return route.fulfill({ json: { success: true, remoteRevoked: true } });
    });
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    await dialog.waitFor();
    await dialog
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor();
    expect(await dialog.textContent()).toContain("Alpha account");
    await dialog
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Connect", exact: true })
      .waitFor();
    expect(await dialog.textContent()).toContain("Not connected");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(
      await page.getByText("My MCP connections", { exact: true }).count()
    ).toBe(0);
  }, 15000);

  test("connect still navigates to the OAuth provider and Escape closes the dialog", async () => {
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              name: "flowaccount",
              connected: false,
              needsReauth: true,
              accountLabel: null,
            },
          ],
        },
      })
    );
    await page.route("**/api/mcp/oauth/start/ws-alpha/flowaccount", (route) =>
      route.fulfill({ json: { url: `${origin}/consent` } })
    );
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    await dialog
      .getByRole("button", { name: "Connect", exact: true })
      .waitFor();
    expect(await dialog.textContent()).toContain("Reconnect required");
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button").click();
    await page
      .getByRole("button", { name: "My MCP connections", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await page.waitForURL(`${origin}/consent`);
  }, 15000);

  test("an empty connector list explains the empty state instead of a blank dialog", async () => {
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) =>
      route.fulfill({ json: { servers: [] } })
    );
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    await dialog
      .getByText("No personal MCP connections are available in this workspace.")
      .waitFor();
    expect(
      await dialog.getByRole("button", { name: /Connect|Disconnect/ }).count()
    ).toBe(0);
  }, 15000);

  test("a failed connection lookup shows an error rather than an empty list", async () => {
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) =>
      route.fulfill({ status: 503, json: { error: "unavailable" } })
    );
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("alert").textContent()).toContain(
      "Connection unavailable"
    );
    expect(
      await dialog.getByRole("button", { name: /Connect|Disconnect/ }).count()
    ).toBe(0);
  }, 15000);
  test("API key connect/replace/cancel clears the password and disconnect skips OAuth warning", async () => {
    let connected = false;
    const keys = [];
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) => route.fulfill({ json: { servers: [{
      name: "tnv2-novels", authType: "apiKey", connected, needsReauth: false,
    }] } }));
    await page.route("**/api/workspace/ws-alpha/mcp-personal/tnv2-novels/api-key", (route) => {
      keys.push(route.request().postDataJSON());
      connected = true;
      return route.fulfill({ json: { success: true } });
    });
    await page.route("**/api/mcp/oauth/disconnect", (route) => {
      connected = false;
      return route.fulfill({ json: { success: true, remoteRevoked: false } });
    });
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    const input = dialog.getByLabel("Your API key for tnv2-novels");
    await input.waitFor();
    expect(await input.getAttribute("type")).toBe("password");
    expect(await dialog.getByRole("button", { name: "Save and connect" }).isDisabled()).toBe(true);
    await input.fill("private-ui-first");
    await dialog.getByRole("button", { name: "Save and connect" }).click();
    await dialog.getByRole("button", { name: "Replace key" }).waitFor();
    expect(keys).toEqual([{ apiKey: "private-ui-first" }]);
    await dialog.getByRole("button", { name: "Replace key" }).click();
    expect(await input.inputValue()).toBe("");
    await input.fill("private-ui-cancel");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Replace key" }).click();
    expect(await input.inputValue()).toBe("");
    await input.fill("private-ui-replacement");
    await dialog.getByRole("button", { name: "Save key", exact: true }).click();
    await dialog.getByRole("button", { name: "Replace key" }).waitFor();
    expect(keys).toEqual([{ apiKey: "private-ui-first" }, { apiKey: "private-ui-replacement" }]);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("private-ui");
    await dialog.getByRole("button", { name: "Replace key" }).click();
    await input.fill("private-ui-discard-on-disconnect");
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await browserExpect(input).toHaveValue("");
    expect(await dialog.textContent()).not.toContain("Remote revocation");
  }, 15000);

  test("failed API key replacement preserves connected UI and closing discards typed key", async () => {
    await page.route("**/api/workspace/ws-alpha/mcp-personal", (route) => route.fulfill({ json: { servers: [{
      name: "tnv2-novels", authType: "apiKey", connected: true, needsReauth: false,
    }] } }));
    await page.route("**/api/workspace/ws-alpha/mcp-personal/tnv2-novels/api-key", (route) => route.fulfill({
      status: 400, json: { error: "personal_api_key_failed" },
    }));
    await openSettings();
    const dialog = page.getByRole("dialog", { name: "My MCP connections" });
    await dialog.getByRole("button", { name: "Replace key" }).click();
    const input = dialog.getByLabel("Your API key for tnv2-novels");
    await input.fill("private-invalid-key");
    await dialog.getByRole("button", { name: "Save key", exact: true }).click();
    await dialog.getByRole("status").waitFor();
    expect(await dialog.textContent()).toContain("Connected");
    expect(await dialog.textContent()).not.toContain("private-invalid-key");
    await page.keyboard.press("Escape");
    await page.getByRole("button").click();
    await page.getByRole("button", { name: "My MCP connections", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Replace key" }).click();
    expect(await page.getByRole("dialog").getByLabel("Your API key for tnv2-novels").inputValue()).toBe("");
  }, 15000);

});
