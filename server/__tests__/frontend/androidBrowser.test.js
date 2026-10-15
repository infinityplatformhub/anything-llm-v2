const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("@playwright/test");
const { build } = require("../../../frontend/node_modules/esbuild");

describe("Android USB browser bridge in the real chat", () => {
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
        import { createAdbDevice } from "./src/utils/android/transport";
        import bridge from "./src/utils/android/bridge";
        window.fixtureBridge = bridge;
        window.fixtureCommands = []; window.fixtureResponses = []; window.fixtureSockets = [];
        window.clipboardWrites = []; window.fixtureUsbClicks = 0;
        const workspace = { id: 75, slug: "ws-android", chatMode: "automatic" };
        i18next.use(initReactI18next).init({ lng: "en", resources: {} });
        window.makeFixtureDevice = () => {
          let close; const closed = new Promise(resolve => close = resolve);
          const adb = { closed, close: async () => close(), subprocess: { shellProtocol: {
            spawn: async (command, signal) => {
              window.fixtureCommands.push(command);
              let output = new Uint8Array(), release, fail;
              if (Array.isArray(command) && command[0] === "screencap") {
                const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 2400;
                canvas.getContext("2d").fillRect(0, 0, 1080, 2400);
                output = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0));
              } else if (typeof command === "string" && command.startsWith("uiautomator")) {
                output = new TextEncoder().encode('<?xml version="1.0"?><hierarchy><node text="ค้นหา" content-desc="Search" resource-id="com.example:id/search" class="android.widget.EditText" bounds="[0,0][200,80]" clickable="true" enabled="true" focused="true"/></hierarchy>');
              }
              const held = window.fixtureHoldTap && Array.isArray(command) && command[1] === "tap";
              const exited = held ? new Promise((resolve, reject) => { release = resolve; fail = reject; }) : Promise.resolve(0);
              let streamController;
              const stdout = new ReadableStream({ start(controller) { streamController = controller;
                if (!held) { controller.enqueue(output); controller.close(); }
              } });
              const kill = () => { if (held) { fail?.(new DOMException("Stopped", "AbortError"));
                try { streamController.error(new DOMException("Stopped", "AbortError")); } catch {}
                release?.(0);
              } };
              signal.addEventListener("abort", kill, { once: true });
              return { stdout, stderr: new ReadableStream({ start(controller) { controller.close(); } }), exited, kill };
            }
          } } };
          return createAdbDevice(adb, "Fixture Android");
        };
        class FixtureSocket extends EventTarget {
          static OPEN = 1; readyState = 0;
          constructor(url, protocols) {
            super(); this.protocols = protocols; window.fixtureSockets.push(this);
            this.plan = window.fixturePlan || [{ action: "inspect", args: { screenshot: true } },
              { action: "tap", args: { x: 123, y: 456 } },
              { action: "type", args: { text: "สวัสดีครับ ABC123" } },
              { action: "key", args: { key: "HOME" } },
              { action: "open_app", args: { packageName: "com.android.settings" } }];
            this.index = 0;
            setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.next(); }, 10);
            this.timer = setTimeout(() => this.close(), 300000);
          }
          next() {
            if (this.readyState !== 1) return;
            if (this.index < this.plan.length) {
              const command = this.plan[this.index++];
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "androidCommand", id: "command-" + this.index, ...command }) }));
            } else {
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "reportStreamEvent", content: { type: "fullTextResponse", uuid: "android-reply", content: "Android task complete." } }) }));
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "WAITING_ON_INPUT", question: "Next task?" }) }));
            }
          }
          send(raw) { const value = JSON.parse(raw); window.fixtureResponses.push(value);
            if (value.type === "androidResult") queueMicrotask(() => this.next());
          }
          close() { if (this.readyState === 3) return; clearTimeout(this.timer); this.readyState = 3; this.dispatchEvent(new Event("close")); }
        }
        window.WebSocket = FixtureSocket;
        const role = new URLSearchParams(location.search).get("role") || "default";
        const router = createMemoryRouter([{ path: "*", element:
          <AuthContext.Provider value={{ store: { user: { id: 2, role } } }}>
            <TTSProvider><DnDFileUploaderProvider workspace={workspace} threadSlug="thread-125">
              <ChatContainer workspace={workspace} threadSlug="thread-125" />
            </DnDFileUploaderProvider></TTSProvider>
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
      plugins: [
        {
          name: "usb-and-scrcpy-test-boundaries",
          setup(build) {
            build.onResolve({ filter: /^\.\/transport$/ }, (args) =>
              args.importer.endsWith("/utils/android/bridge.js")
                ? { path: "usb-picker", namespace: "fixture" }
                : null
            );
            build.onResolve({ filter: /^@yume-chan\/adb-scrcpy$/ }, () => ({
              path: "scrcpy",
              namespace: "fixture",
            }));
            build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              contents:
                args.path === "usb-picker"
                  ? "export async function connectUsb() { window.fixtureUsbClicks++; window.fixtureUserGesture = navigator.userActivation.isActive; return window.makeFixtureDevice(); }"
                  : "export class AdbScrcpyOptions3_3_1 { constructor(value) { this.value = value; } } export class AdbScrcpyClient { static async pushServer(adb, stream, filename) { window.fixtureServerPath = filename; const reader = stream.getReader(); await reader.read(); await reader.read(); } static async start(adb, filename, options) { window.fixtureScrcpyOptions = options.value; return { output: new ReadableStream({ start(c) { c.close(); } }), exited: new Promise(() => {}), controller: { async setClipboard(value) { window.clipboardWrites.push(value.content); } }, async close() {} }; } }",
              loader: "js",
            }));
          },
        },
      ],
      logLevel: "silent",
    });
    const html = fs.readFileSync(
      path.join(frontend, "dist/_index.html"),
      "utf8"
    );
    const cssPath = html.match(/href="([^\"]+\.css)"/)?.[1];
    const css = cssPath
      ? fs.readFileSync(path.join(frontend, "dist", cssPath), "utf8")
      : "";
    server = http.createServer((req, res) => {
      if (req.url === "/app.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle.outputFiles[0].text);
      } else if (req.url === "/app.css") {
        res.setHeader("Content-Type", "text/css");
        res.end(css);
      } else if (req.url === "/android/scrcpy-server-v3.3.1")
        res.end(
          fs.readFileSync(
            path.join(frontend, "public/android/scrcpy-server-v3.3.1")
          )
        );
      else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'
        );
      }
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
  async function open(role = "default", init) {
    page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "usb", { value: {} })
    );
    if (init) await page.addInitScript(init);
    await page.route("**/api/**", (route) =>
      route.fulfill({
        json: { servers: [], agents: [], skills: [], models: [] },
      })
    );
    await page.route("**/api/workspace/ws-android", (route) =>
      route.fulfill({
        json: {
          workspace: [
            {
              id: 75,
              slug: "ws-android",
              chatProvider: "openai",
              chatMode: "automatic",
            },
          ],
        },
      })
    );
    const requests = [];
    await page.route(
      "**/api/workspace/ws-android/thread/thread-125/stream-chat",
      (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          contentType: "text/event-stream",
          body: 'data: {"type":"agentInitWebsocketConnection","websocketUUID":"fixture"}\n\n',
        });
      }
    );
    await page.goto(origin + "?role=" + role);
    return { errors, requests };
  }
  async function connect() {
    await page
      .getByRole("button", { name: "Connect Android", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect device", exact: true })
      .click();
    await page.getByText("Fixture Android", { exact: true }).waitFor();
  }
  async function submit(text = "ดูหน้าจอและพิมพ์ข้อความ") {
    await page.locator("#primary-prompt-input").fill(text);
    await page.locator("#primary-prompt-input").press("Enter");
  }
  test.each(["default", "manager", "admin"])(
    "%s sees and can connect Android without an admin-only menu",
    async (role) => {
      const { errors } = await open(role);
      await connect();
      expect(await page.evaluate(() => window.fixtureUsbClicks)).toBe(1);
      expect(await page.evaluate(() => window.fixtureUserGesture)).toBe(true);
      expect(errors).toEqual([]);
    }
  );
  test("USB survives empty→chat, executes typed ADB/Unicode clipboard commands, and rebinds after five minutes", async () => {
    const { errors, requests } = await open();
    await page.clock.install();
    await connect();
    await submit();
    await page.clock.runFor(500);
    await page.getByText("Android task complete.", { exact: true }).waitFor();
    expect(requests[0].androidBridge).toMatchObject({ connected: true });
    expect(requests[0].androidBridge.token).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await page.evaluate(() => window.fixtureSockets[0].protocols)
    ).toContain("anythingllm-android." + requests[0].androidBridge.token);
    expect(await page.evaluate(() => window.fixtureCommands)).toContainEqual([
      "input",
      "tap",
      "123",
      "456",
    ]);
    expect(await page.evaluate(() => window.fixtureCommands)).toContainEqual([
      "input",
      "keyevent",
      "3",
    ]);
    expect(await page.evaluate(() => window.fixtureCommands)).toContainEqual([
      "monkey",
      "-p",
      "com.android.settings",
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    expect(await page.evaluate(() => window.clipboardWrites)).toEqual([
      "สวัสดีครับ ABC123",
    ]);
    expect(
      await page.evaluate(() => window.fixtureScrcpyOptions)
    ).toMatchObject({ video: false, audio: false, clipboardAutosync: false });
    const inspect = await page.evaluate(
      () =>
        window.fixtureResponses.find((response) => response.id === "command-1")
          .result
    );
    expect(inspect).toMatchObject({
      width: 1080,
      height: 2400,
      image: { mime: "image/jpeg", width: 720, height: 1600 },
      nodes: [{ text: "ค้นหา" }],
    });
    expect(inspect.image.data.startsWith("/9j/")).toBe(true);
    expect(JSON.stringify(inspect)).not.toContain("preview");
    await page.clock.runFor(300001);
    await submit("ต่อจากเมื่อกี้");
    await page.clock.runFor(500);
    expect(requests).toHaveLength(2);
    expect(requests[1].androidBridge.token).toBe(
      requests[0].androidBridge.token
    );
    expect(requests[1].conversationHistory).toContainEqual({
      role: "assistant",
      content: "Android task complete.",
    });
    expect(await page.evaluate(() => window.fixtureUsbClicks)).toBe(1);
    expect(errors).toEqual([]);
  });
  test("Stop AI cancels a pending command and prevents queued actions while retaining USB", async () => {
    const { errors } = await open("default", () => {
      window.fixtureHoldTap = true;
      window.fixturePlan = [{ action: "tap", args: { x: 1, y: 2 } }];
    });
    await connect();
    await submit();
    await page.waitForFunction(() => window.fixtureCommands.length === 1);
    await page.evaluate(() =>
      window.fixtureSockets[0].dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "androidCommand",
            id: "queued",
            action: "key",
            args: { key: "HOME" },
          }),
        })
      )
    );
    await page
      .getByRole("button", { name: "Connect Android", exact: true })
      .click();
    await page.getByRole("button", { name: "Stop AI", exact: true }).click();
    expect(await page.evaluate(() => window.fixtureSockets[0].readyState)).toBe(
      3
    );
    expect(await page.evaluate(() => window.fixtureCommands)).toHaveLength(1);
    expect(
      await page.evaluate(() => window.fixtureBridge.getBinding().connected)
    ).toBe(true);
    expect(errors).toEqual([]);
  });
  test("disconnect and login change remove control and private device state", async () => {
    await open();
    await connect();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect(
      await page.evaluate(() => window.fixtureBridge.getBinding().connected)
    ).toBe(false);
    await page.evaluate(() =>
      window.fixtureBridge.bindOwner("another-session")
    );
    expect(
      await page.evaluate(() => window.fixtureBridge.getBinding())
    ).toBeNull();
    expect(
      await page.evaluate(() => window.fixtureBridge.getSnapshot().preview)
    ).toBeNull();
  });
});
