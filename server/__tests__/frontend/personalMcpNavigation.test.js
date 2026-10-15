const http = require("http");
const path = require("path");
const { chromium, expect: browserExpect } = require("@playwright/test");
const { build } = require("../../../frontend/node_modules/esbuild");

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
        import { MemoryRouter, Routes, Route } from "react-router-dom";
        import i18next from "i18next";
        import { initReactI18next } from "react-i18next";
        import { AuthContext } from "./src/AuthContext";
        import { PfpContext } from "./src/PfpContext";
        import UserButton from "./src/components/UserMenu/UserButton";
        import ServerModal from "./src/pages/WorkspaceSettings/AgentConfig/McpConnectors/ServerModal";
        const user = { id: 7, role: "default", username: "member" };
        localStorage.setItem("anythingllm_user", JSON.stringify(user));
        localStorage.setItem("anythingllm_authToken", "fixture-browser-session");
        i18next.use(initReactI18next).init({ lng: "en", resources: {} });
        const edited = { name: "tnv2-novels", config: { type: "streamable", url: "https://api.thai-novel.com/api/v1/mcp-remote", anythingllm: { perUserAuth: true, personalAuth: { type: "apiKey", header: "X-API-Key" }, categoryLoading: true, suppressedTools: [] } } };
        const surface = new URLSearchParams(location.search).get("surface");
        createRoot(document.getElementById("root")).render(
          <MemoryRouter initialEntries={[surface === "home" ? "/" : "/workspace/tnv"]}>
            <AuthContext.Provider value={{ store: { user } }}><PfpContext.Provider value={{ pfp: null, setPfp: () => {} }}>
              <Routes><Route path="/workspace/:slug" element={surface === "editor"
                ? <ServerModal slug="tnv" server={edited} onClose={() => {}} onSaved={() => {}} />
                : <UserButton />} /><Route path="/" element={<UserButton />} /></Routes>
            </PfpContext.Provider></AuthContext.Provider>
          </MemoryRouter>
        );
      `,
    },
    bundle: true, write: false, jsx: "automatic",
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    alias: { "@": path.join(frontend, "src") },
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/app.js" ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/app.js"></script>');
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
  page.setDefaultTimeout(3000);
  page.on("pageerror", (error) => { throw error; });
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
});
afterEach(async () => page?.close());

test("ordinary member opens personal API key input from their account menu without organization APIs", async () => {
  const sharedRequests = [];
  page.on("request", (request) => {
    if (/\/mcp-servers|\/mcp\/toggle|\/admin\//.test(request.url())) sharedRequests.push(request.url());
  });
  await page.route("**/api/workspace/tnv/mcp-personal", (route) => route.fulfill({ json: { servers: [{ name: "tnv2-novels", authType: "apiKey", connected: false }] } }));
  await page.goto(origin);
  await page.getByRole("button").first().click();
  await page.getByRole("button", { name: "My MCP connections", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "My MCP connections", exact: true });
  await browserExpect(dialog.getByLabel("Your API key for tnv2-novels")).toHaveAttribute("type", "password");
  expect(sharedRequests).toEqual([]);
});

test("editing a personal API key connector preserves its auth mode and existing options", async () => {
  await page.route("**/api/workspace/tnv/mcp-servers/tnv2-novels", async (route) => {
    await route.fulfill({ json: { success: true } });
  });
  await page.goto(`${origin}/?surface=editor`);
  const saving = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/api/workspace/tnv/mcp-servers/tnv2-novels"));
  await page.getByRole("button", { name: "agent.mcp.save", exact: true }).click();
  const saved = (await saving).postDataJSON();
  expect(saved.config.anythingllm).toEqual({
    perWorkspaceAuth: false, perUserAuth: true,
    personalAuth: { type: "apiKey", header: "X-API-Key" },
    categoryLoading: true, suppressedTools: [],
  });
});

test("personal account menu works outside a room and discards typed keys when changing rooms", async () => {
  let saves = 0;
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: { workspaces: [{ name: "Alpha", slug: "alpha" }, { name: "Beta", slug: "beta" }] } }));
  await page.route("**/api/workspace/*/mcp-personal", (route) => route.fulfill({ json: { servers: [{ name: "tnv2-novels", authType: "apiKey", connected: false }] } }));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api-key")) saves++;
  });
  await page.goto(`${origin}/?surface=home`);
  await page.getByRole("button", { name: "User menu", exact: true }).click();
  await page.getByRole("button", { name: "My MCP connections", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "My MCP connections", exact: true });
  const input = dialog.getByLabel("Your API key for tnv2-novels");
  await input.fill("fixture-unsubmitted-personal-key");
  await dialog.getByRole("combobox", { name: /Workspace/ }).selectOption("beta");
  await browserExpect(input).toHaveValue("");
  await dialog.getByRole("combobox", { name: /Workspace/ }).selectOption("alpha");
  await browserExpect(input).toHaveValue("");
  expect(saves).toBe(0);
});
