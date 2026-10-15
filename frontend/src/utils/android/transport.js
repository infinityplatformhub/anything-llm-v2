import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";

const SERVER_PATH = "/data/local/tmp/anythingllm-scrcpy-3.3.1.jar";
const SERVER_SHA256 =
  "a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8";
const KEY_CODES = {
  BACK: 4,
  HOME: 3,
  ENTER: 66,
  DEL: 67,
  APP_SWITCH: 187,
  TAB: 61,
};

function check(signal) {
  if (signal?.aborted)
    throw new DOMException("Android action stopped.", "AbortError");
}

async function readBytes(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Android output is too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function nodesFromXml(xml) {
  const start = xml.indexOf("<?xml");
  if (start < 0) return [];
  const document = new DOMParser().parseFromString(
    xml.slice(start),
    "text/xml"
  );
  if (document.querySelector("parsererror")) return [];
  return [...document.querySelectorAll("node")].slice(0, 400).map((node) => ({
    text: (node.getAttribute("text") || "").slice(0, 500),
    description: (node.getAttribute("content-desc") || "").slice(0, 500),
    resourceId: (node.getAttribute("resource-id") || "").slice(0, 200),
    className: (node.getAttribute("class") || "").slice(0, 200),
    bounds: (node.getAttribute("bounds") || "").slice(0, 80),
    clickable: node.getAttribute("clickable") === "true",
    enabled: node.getAttribute("enabled") === "true",
    focused: node.getAttribute("focused") === "true",
  }));
}

async function screenshotFromPng(bytes) {
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/png" })
  );
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (dataUrl.length > 1_500_000)
      dataUrl = canvas.toDataURL("image/jpeg", 0.5);
    if (dataUrl.length > 1_500_000)
      throw new Error("Android screenshot is too large.");
    return {
      width: bitmap.width,
      height: bitmap.height,
      image: {
        mime: "image/jpeg",
        data: dataUrl.split(",")[1],
        width: canvas.width,
        height: canvas.height,
      },
      preview: dataUrl,
    };
  } finally {
    bitmap.close();
  }
}

export function createAdbDevice(adb, name) {
  let clipboardClient = null;
  let clipboardPromise = null;
  let closed = false;
  const processes = new Set();

  async function run(command, signal, limit = 256 * 1024) {
    check(signal);
    if (closed) throw new Error("Android is disconnected.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 12_000);
    let process;
    try {
      check(signal);
      // Android 7+ supplies shell-v2, including separate binary stdout/stderr.
      if (!adb.subprocess.shellProtocol)
        throw new Error("Android 7 or later is required.");
      process = await adb.subprocess.shellProtocol.spawn(
        command,
        controller.signal
      );
      processes.add(process);
      const [stdout, , exitCode] = await Promise.all([
        readBytes(process.stdout, limit),
        readBytes(process.stderr, 64 * 1024),
        process.exited,
      ]);
      check(signal);
      if (controller.signal.aborted)
        throw new Error("Android action timed out.");
      if (exitCode !== 0)
        throw new Error("Android command failed. Check the device screen.");
      return stdout;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (process) {
        processes.delete(process);
        await Promise.resolve(process.kill()).catch(() => {});
      }
    }
  }

  async function clipboard(signal) {
    if (!clipboardPromise) {
      clipboardPromise = (async () => {
        const { AdbScrcpyClient, AdbScrcpyOptions3_3_1 } = await import(
          "@yume-chan/adb-scrcpy"
        );
        check(signal);
        const response = await fetch(
          `${import.meta.env.BASE_URL || "/"}android/scrcpy-server-v3.3.1`,
          { signal }
        );
        if (!response.ok)
          throw new Error("Android text input helper could not be loaded.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes)
        );
        const hex = [...digest]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        if (hex !== SERVER_SHA256)
          throw new Error("Android text input helper failed verification.");
        check(signal);
        await AdbScrcpyClient.pushServer(
          adb,
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          SERVER_PATH
        );
        check(signal);
        const client = await AdbScrcpyClient.start(
          adb,
          SERVER_PATH,
          new AdbScrcpyOptions3_3_1({
            video: false,
            audio: false,
            control: true,
            clipboardAutosync: false,
            tunnelForward: true,
            cleanup: true,
            scid: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
          })
        );
        // Drain every incoming stream so it cannot stall the multiplexed USB link.
        client.output
          .pipeTo(new WritableStream({ write() {} }))
          .catch(() => {});
        if (client.clipboard)
          client.clipboard
            .pipeTo(new WritableStream({ write() {} }))
            .catch(() => {});
        if (closed) {
          await client.close();
          throw new Error("Android is disconnected.");
        }
        clipboardClient = client;
        client.exited
          .finally(() => {
            clipboardClient = null;
            clipboardPromise = null;
          })
          .catch(() => {});
        return client;
      })().catch((error) => {
        clipboardPromise = null;
        throw error;
      });
    }
    const client = await clipboardPromise;
    check(signal);
    return client;
  }

  const integer = (v, max = 16_384) =>
    Number.isInteger(v) && v >= 0 && v <= max;
  return {
    name,
    closed: adb.closed,
    async close() {
      closed = true;
      for (const process of processes)
        Promise.resolve(process.kill()).catch(() => {});
      await clipboardClient?.close().catch(() => {});
      await adb.close();
    },
    async execute(action, args = {}, signal) {
      check(signal);
      if (closed) throw new Error("Android is disconnected.");
      switch (action) {
        case "inspect": {
          const [capture, ui] = await Promise.allSettled([
            run(["screencap", "-p"], signal, 16 * 1024 * 1024).then(
              screenshotFromPng
            ),
            run(
              "uiautomator dump /data/local/tmp/anythingllm-window.xml >/dev/null && cat /data/local/tmp/anythingllm-window.xml",
              signal
            ).then((bytes) => nodesFromXml(new TextDecoder().decode(bytes))),
          ]);
          check(signal);
          if (capture.status === "rejected") throw capture.reason;
          return {
            width: capture.value.width,
            height: capture.value.height,
            nodes: ui.status === "fulfilled" ? ui.value : [],
            uiUnavailable: ui.status !== "fulfilled" || ui.value.length === 0,
            preview: capture.value.preview,
            ...(args.screenshot !== false
              ? { image: capture.value.image }
              : {}),
          };
        }
        case "tap":
          if (!integer(args.x) || !integer(args.y)) break;
          await run(["input", "tap", String(args.x), String(args.y)], signal);
          return { success: true };
        case "swipe":
          if (
            ![args.x1, args.y1, args.x2, args.y2].every((v) => integer(v)) ||
            !integer(args.duration ?? 300, 2000)
          )
            break;
          await run(
            [
              "input",
              "swipe",
              ...[args.x1, args.y1, args.x2, args.y2, args.duration ?? 300].map(
                String
              ),
            ],
            signal
          );
          return { success: true };
        case "type": {
          if (
            typeof args.text !== "string" ||
            !args.text.length ||
            new TextEncoder().encode(args.text).byteLength > 8192 ||
            args.text.includes("\0")
          )
            break;
          const client = await clipboard(signal);
          check(signal);
          await client.controller.setClipboard({
            sequence: 0n,
            paste: true,
            content: args.text,
          });
          check(signal);
          return { success: true };
        }
        case "key":
          if (!Object.hasOwn(KEY_CODES, args.key)) break;
          await run(["input", "keyevent", String(KEY_CODES[args.key])], signal);
          return { success: true };
        case "open_app":
          if (
            typeof args.packageName !== "string" ||
            args.packageName.length > 200 ||
            !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(args.packageName)
          )
            break;
          await run(
            [
              "monkey",
              "-p",
              args.packageName,
              "-c",
              "android.intent.category.LAUNCHER",
              "1",
            ],
            signal
          );
          return { success: true };
      }
      throw new Error("Unsupported Android action or invalid parameters.");
    },
  };
}

export async function connectUsb(signal) {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager)
    throw new Error("Use Chrome or Edge over HTTPS to connect Android.");
  // Keep the picker before any dynamic import: WebUSB requires this user gesture.
  const device = await manager.requestDevice();
  if (!device) return null;
  check(signal);
  const [{ Adb, AdbDaemonTransport }, { default: AdbWebCredentialStore }] =
    await Promise.all([
      import("@yume-chan/adb"),
      import("@yume-chan/adb-credential-web"),
    ]);
  check(signal);
  const connection = await device.connect();
  const cancel = () => device.raw.close().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    check(signal);
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: new AdbWebCredentialStore("AnythingLLM Android"),
    });
    if (signal?.aborted) {
      await transport.close();
      check(signal);
    }
    return createAdbDevice(new Adb(transport), device.name || "Android");
  } catch (error) {
    await device.raw.close().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
