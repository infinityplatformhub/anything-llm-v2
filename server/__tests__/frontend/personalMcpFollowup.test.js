const http = require("node:http");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const { build } = require("../../../frontend/node_modules/esbuild");

const prompt = "สรุป poro playmat ขายได้หรือยัง";
const reply =
  "Poro Playmat Layout 3 มีของพร้อมขายกี่ผืนครับ? จะลงที่ Red Ball Store Warehouse";

describe("same-page personal follow-up after the agent socket expires", () => {
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
          import { createMemoryRouter, RouterProvider } from "react-router-dom";
          import i18next from "i18next";
          import { initReactI18next } from "react-i18next";
          import { AuthContext } from "./src/AuthContext";
          import { TTSProvider } from "./src/components/contexts/TTSProvider";
          import { DnDFileUploaderProvider } from "./src/components/WorkspaceChat/ChatContainer/DnDWrapper";
          import ChatContainer from "./src/components/WorkspaceChat/ChatContainer";
          i18next.use(initReactI18next).init({ lng: "en", resources: {} });
          const workspace = { id: 75, slug: "ws-private", chatMode: "automatic" };
          window.fixtureSockets = [];
          class FixtureSocket extends EventTarget {
            static OPEN = 1;
            readyState = 0;
            constructor() {
              super();
              window.fixtureSockets.push(this);
              setTimeout(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event("open"));
                this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
                  type: "reportStreamEvent", content: { type: "fullTextResponse", uuid: "stock-answer", content: ${JSON.stringify(reply)} }
                }) }));
                this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "WAITING_ON_INPUT", question: "quantity" }) }));
              }, 10);
              this.timer = setTimeout(() => this.close(), 300000);
            }
            send() {}
            close() {
              if (this.readyState === 3) return;
              clearTimeout(this.timer);
              this.readyState = 3;
              this.dispatchEvent(new Event("close"));
            }
          }
          window.WebSocket = FixtureSocket;
          const router = createMemoryRouter([{ path: "*", element:
            <AuthContext.Provider value={{ store: { user: { id: 2, role: "default" } } }}>
              <TTSProvider>
                <DnDFileUploaderProvider workspace={workspace} threadSlug="thread-125">
                  <ChatContainer workspace={workspace} threadSlug="thread-125" />
                </DnDFileUploaderProvider>
              </TTSProvider>
            </AuthContext.Provider>
          }]);
          createRoot(document.getElementById("root")).render(<RouterProvider router={router} />);
        `,
      },
      bundle: true,
      write: false,
      jsx: "automatic",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
      loader: {
        ".css": "empty",
        ".png": "dataurl",
        ".svg": "dataurl",
        ".jpg": "dataurl",
        ".jpeg": "dataurl",
        ".webp": "dataurl",
        ".webm": "dataurl",
        ".mp4": "dataurl",
        ".gif": "dataurl",
      },
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
  afterEach(async () => page?.close());

  test("the follow-up HTTP request includes the stock question once after five minutes, without thought/status messages", async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await page.route("**/api/**", (route) =>
      route.fulfill({
        json: { servers: [], agents: [], skills: [], models: [] },
      })
    );
    await page.route("**/api/workspace/ws-private", (route) =>
      route.fulfill({
        json: {
          workspace: [
            {
              id: 75,
              slug: "ws-private",
              chatProvider: "openai",
              chatMode: "automatic",
            },
          ],
        },
      })
    );
    const requests = [];
    await page.route(
      "**/api/workspace/ws-private/thread/thread-125/stream-chat",
      (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          contentType: "text/event-stream",
          body:
            route.request().postDataJSON().message === "/reset"
              ? 'data: {"type":"textResponse","textResponse":"Chat memory was reset!","action":"reset_chat","close":true}\n\n'
              : 'data: {"type":"agentInitWebsocketConnection","websocketUUID":"fixture"}\n\n',
        });
      }
    );
    await page.goto(origin);
    expect(errors).toEqual([]);
    await page.locator("#primary-prompt-input").fill(prompt);
    await page.locator("#primary-prompt-input").press("Enter");
    await page
      .waitForFunction(() => window.fixtureSockets.length === 1)
      .catch(async (error) => {
        throw new Error(
          error.message +
            "\n" +
            JSON.stringify({
              errors,
              requests,
              visible: (await page.locator("body").textContent()).slice(
                0,
                2000
              ),
            })
        );
      });
    await page.clock.runFor(100);
    await page
      .getByText(reply, { exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          error.message +
            "\n" +
            JSON.stringify({
              errors,
              requests,
              visible: (await page.locator("body").textContent()).slice(
                0,
                2000
              ),
            })
        );
      });
    await page.clock.fastForward(300001);
    await page.locator("#primary-prompt-input").fill("1ผืน");
    const followupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/stream-chat") &&
        response.request().postDataJSON().message === "1ผืน"
    );
    await page.locator("#primary-prompt-input").press("Enter");
    await followupResponse;
    await page.waitForFunction(
      () => document.querySelector("#primary-prompt-input").value === ""
    );
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1].conversationHistory).toEqual([
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ]);
    expect(requests[1].message).toBe("1ผืน");
    await page.waitForFunction(() => window.fixtureSockets.length === 2);
    await page.clock.runFor(100);
    await page.locator("#primary-prompt-input").fill("/reset");
    const resetResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/stream-chat") &&
        response.request().postDataJSON().message === "/reset"
    );
    await page.locator("#primary-prompt-input").press("Enter");
    await resetResponse;
    expect(requests[2].conversationHistory).toEqual([]);
  }, 20000);
});
