const fs = require("fs");
const path = require("path");
const frontend = path.resolve(__dirname, "../../../frontend");
const frontendRequire = require("module").createRequire(
  `${frontend}/package.json`
);
const React = frontendRequire("react");
const { createRoot } = frontendRequire("react-dom/client");
const { act } = frontendRequire("react-dom/test-utils");
const { JSDOM } = require("jsdom");
const { transformSync } = frontendRequire("esbuild");

function loadSource(relativePath, dependencies) {
  const { code } = transformSync(
    fs.readFileSync(path.join(frontend, relativePath), "utf8"),
    { loader: "jsx", jsx: "automatic", format: "cjs" }
  );
  const output = { exports: {} };
  new Function("require", "module", "exports", code)(
    (specifier) => dependencies[specifier] ?? frontendRequire(specifier),
    output,
    output.exports
  );
  return output.exports.default;
}

const saveAs = jest.fn();
const showToast = jest.fn();
const StorageFiles = loadSource("src/models/files.js", {
  "@/utils/constants": { API_BASE: "/api" },
  "@/utils/request": { baseHeaders: () => ({ Authorization: "Bearer test" }) },
});
const FileDownloadCard = loadSource(
  "src/components/WorkspaceChat/ChatContainer/ChatHistory/FileDownloadCard/index.jsx",
  {
    "file-saver": { saveAs },
    "@phosphor-icons/react": {
      DownloadSimple: () => null,
      CircleNotch: () => null,
    },
    "@/utils/numbers": { humanFileSize: () => "9.4 kB" },
    "@/models/files": StorageFiles,
    "@/utils/toast": showToast,
  }
);

let dom;
let root;
let originals;
const content = {
  filename: "report.xlsx",
  storageFilename: "xlsx-11111111-2222-4333-8444-555555555555.xlsx",
  fileSize: 9400,
};

beforeEach(() => {
  jest.clearAllMocks();
  originals = Object.getOwnPropertyDescriptors(global);
  dom = new JSDOM("<div id='root'></div>", { url: "https://example.test" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = jest.fn();
  root = createRoot(document.getElementById("root"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  for (const key of [
    "window",
    "document",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ]) {
    if (originals[key]) Object.defineProperty(global, key, originals[key]);
    else delete global[key];
  }
});

async function render(payload = content) {
  await act(async () =>
    root.render(
      React.createElement(FileDownloadCard, {
        props: { content: payload },
      })
    )
  );
  return document.querySelector("button");
}

test.each(["report.xlsx", "\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19.xlsx"])(
  "downloads with authentication and keeps the display filename %s",
  async (filename) => {
    const blob = new Blob(["workbook"]);
    fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    const button = await render({ ...content, filename });
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledWith(
      `/api/agent-skills/generated-files/${content.storageFilename}`,
      { headers: { Authorization: "Bearer test" } }
    );
    expect(saveAs).toHaveBeenCalledWith(blob, filename);
    expect(showToast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  }
);

test.each([
  [401, /session has expired/],
  [403, /permission/],
  [404, /no longer available/],
  [500, /HTTP 500/],
])(
  "shows an actionable error for HTTP %s and allows retry",
  async (status, message) => {
    fetch.mockResolvedValue({ ok: false, status });
    const button = await render();
    await act(async () => button.click());
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(message),
      "error"
    );
    expect(saveAs).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);

    const blob = new Blob(["retry"]);
    fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    await act(async () => button.click());
    expect(saveAs).toHaveBeenCalledWith(blob, "report.xlsx");
  }
);

test("reports a missing file reference instead of silently doing nothing", async () => {
  const button = await render({ filename: "old.xlsx" });
  await act(async () => button.click());
  expect(fetch).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(
    expect.stringContaining("generate it again"),
    "error"
  );
});

test("reports network failures and clears the loading state", async () => {
  fetch.mockRejectedValue(new Error("Failed to fetch"));
  const button = await render();
  await act(async () => button.click());
  expect(showToast).toHaveBeenCalledWith("Failed to fetch", "error");
  expect(button.textContent).toBe("Download");
  expect(button.disabled).toBe(false);
});

test("disables repeated clicks while waiting for the download response", async () => {
  let finishFetch;
  fetch.mockReturnValue(new Promise((resolve) => (finishFetch = resolve)));
  const button = await render();
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Downloading...");
  await act(async () => button.click());
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () =>
    finishFetch({
      ok: true,
      status: 200,
      blob: async () => new Blob(["data"]),
    })
  );
  expect(button.disabled).toBe(false);
});
