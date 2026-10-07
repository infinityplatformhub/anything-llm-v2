// Run the actual JSX component with React and a DOM; only network/UI boundaries
// are replaced. No new frontend test dependency or production test hook is needed.
const fs = require("fs");
const path = require("path");
const frontend = path.resolve(__dirname, "../../../frontend");
const frontendRequire = require("module").createRequire(
  `${frontend}/package.json`
);
const React = frontendRequire("react");
const { createRoot } = frontendRequire("react-dom/client");
const { act } = React;
const { JSDOM } = require("../../node_modules/jsdom");
const { transformSync } = frontendRequire("esbuild");

let context;
let modal;
let root;
let dom;
let originals;
const workspaceApi = {
  maxContextWindowLimit: 0.8,
  getParsedFiles: jest.fn(),
  parseFile: jest.fn(),
  deleteParsedFiles: jest.fn(),
  deleteAndUnembedFile: jest.fn(),
  embedParsedFile: jest.fn(),
};
const toast = jest.fn();
const processorOnline = jest.fn();
const source = fs.readFileSync(
  `${frontend}/src/components/WorkspaceChat/ChatContainer/DnDWrapper/index.jsx`,
  "utf8"
);
const { code } = transformSync(source, {
  loader: "jsx",
  jsx: "automatic",
  format: "cjs",
});
const moduleOutput = { exports: {} };
new Function("require", "module", "exports", code)(
  (specifier) => {
    if (specifier === "@/models/system")
      return { checkDocumentProcessorOnline: processorOnline };
    if (specifier === "@/models/workspace") return workspaceApi;
    if (specifier === "@/utils/toast") return toast;
    if (specifier === "./FileUploadWarningModal")
      return (props) => {
        modal = props;
        return null;
      };
    if (specifier.endsWith(".png")) return "icon";
    return frontendRequire(specifier);
  },
  moduleOutput,
  moduleOutput.exports
);
const {
  DnDFileUploaderProvider,
  DndUploaderContext,
  ATTACHMENTS_PROCESSED_EVENT,
} = moduleOutput.exports;
const DnDWrapper = moduleOutput.exports.default;
const menuOutput = { exports: {} };
const menuCode = transformSync(
  fs.readFileSync(
    `${frontend}/src/components/WorkspaceChat/ChatContainer/PromptInput/AttachItem/ParsedFilesMenu/index.jsx`,
    "utf8"
  ),
  { loader: "jsx", jsx: "automatic", format: "cjs" }
).code;
new Function("require", "module", "exports", menuCode)(
  (specifier) => {
    if (specifier === "../../../DnDWrapper") return moduleOutput.exports;
    if (specifier === "@/models/workspace") return workspaceApi;
    if (specifier === "@/utils/toast") return toast;
    if (specifier === "@/utils/numbers") return { nFormatter: String };
    if (specifier === "@/hooks/useUser")
      return {
        useUser: () => ({ user: { role: "admin" } }),
        __esModule: true,
        default: () => ({ user: { role: "admin" } }),
      };
    return frontendRequire(specifier);
  },
  menuOutput,
  menuOutput.exports
);
const attachOutput = { exports: {} };
const attachCode = transformSync(
  fs.readFileSync(
    `${frontend}/src/components/WorkspaceChat/ChatContainer/PromptInput/AttachItem/index.jsx`,
    "utf8"
  ),
  { loader: "jsx", jsx: "automatic", format: "cjs" }
).code;
new Function("require", "module", "exports", attachCode)(
  (specifier) => {
    if (specifier === "../../DnDWrapper") return moduleOutput.exports;
    if (specifier === "@/models/workspace") return workspaceApi;
    if (specifier === "@/hooks/useTheme")
      return { useTheme: () => ({ theme: "dark" }) };
    if (specifier === "react-router-dom") return { useParams: () => ({}) };
    if (specifier === "react-i18next")
      return { useTranslation: () => ({ t: (key) => key }) };
    if (specifier === "./ParsedFilesMenu") return () => null;
    return frontendRequire(specifier);
  },
  attachOutput,
  attachOutput.exports
);

it("removes a parsed document while retaining an image with no document metadata", async () => {
  const listeners = jest.spyOn(window, "addEventListener");
  await render();
  await act(async () =>
    context.onDrop([
      new File(["image"], "image.png", { type: "image/png" }),
      new File(["text"], "doc.txt", { type: "text/plain" }),
    ])
  );
  expect(context.files).toHaveLength(2);
  const remove = listeners.mock.calls.find(
    ([name]) => name === "PARSED_FILE_ATTACHMENT_REMOVED"
  )[1];
  await act(async () =>
    remove(
      new CustomEvent("PARSED_FILE_ATTACHMENT_REMOVED", {
        detail: { document: { id: 1 } },
      })
    )
  );
  expect(context.files).toHaveLength(1);
  expect(context.files[0].file.name).toBe("image.png");
  listeners.mockRestore();
});

it("removing an image does not attempt to delete a parsed document", async () => {
  const listeners = jest.spyOn(window, "addEventListener");
  await act(async () =>
    root.render(
      React.createElement(
        DnDFileUploaderProvider,
        { workspace: { slug: "one" } },
        React.createElement(attachOutput.exports.default, {
          workspaceSlug: "one",
        })
      )
    )
  );
  const remove = listeners.mock.calls.find(
    ([name]) => name === "ATTACHMENT_REMOVE"
  )[1];
  await expect(
    remove(
      new CustomEvent("ATTACHMENT_REMOVE", { detail: { uid: "image-uid" } })
    )
  ).resolves.toBeUndefined();
  expect(workspaceApi.deleteParsedFiles).not.toHaveBeenCalled();
  listeners.mockRestore();
});

it.each([
  [true, "success"],
  [false, "error"],
])("modal embedding reports actual response ok=%s", async (ok, severity) => {
  workspaceApi.getParsedFiles.mockResolvedValue({
    currentContextTokenCount: 100,
    contextWindow: 100,
  });
  await render();
  await act(async () =>
    context.onDrop([new File(["text"], "doc.txt", { type: "text/plain" })])
  );
  expect(modal.show).toBe(true);
  workspaceApi.embedParsedFile.mockResolvedValue({
    response: { ok },
    data: {},
  });
  await act(async () => modal.onEmbed());
  expect(toast).toHaveBeenLastCalledWith(
    ok ? "1 file embedded successfully" : "Failed to embed files",
    severity
  );
  expect(context.files[0].status).toBe(ok ? "embedded" : "failed");
});

it.each([
  [[true, true], "success"],
  [[true, false], "error"],
  [[false, false], "error"],
])(
  "parsed menu embedding reports batch results %j",
  async (responses, severity) => {
    for (const ok of responses)
      workspaceApi.embedParsedFile.mockResolvedValueOnce({
        response: { ok },
        data: {},
      });
    await act(async () =>
      root.render(
        React.createElement(menuOutput.exports.default, {
          files: [
            { id: 1, title: "one" },
            { id: 2, title: "two" },
          ],
          setFiles: jest.fn(),
          currentTokens: 100,
          contextWindow: 100,
          setCurrentTokens: jest.fn(),
          workspaceSlug: "one",
          isLoading: false,
        })
      )
    );
    const button = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent === "Embed Files into Workspace"
    );
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(toast).toHaveBeenLastCalledWith(
      severity === "success"
        ? "2 files embedded successfully"
        : "Failed to embed files",
      severity
    );
    expect(document.body.textContent).not.toContain("Embedding 1 of");
  }
);
function Probe() {
  context = React.useContext(DndUploaderContext);
  return null;
}
async function render(slug = "one", threadSlug = null) {
  await act(async () =>
    root.render(
      React.createElement(
        DnDFileUploaderProvider,
        { workspace: { slug }, threadSlug },
        React.createElement(Probe)
      )
    )
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const parsed = {
  response: { ok: true },
  data: { files: [{ id: 1, tokenCountEstimate: 1 }] },
};
beforeEach(() => {
  jest.clearAllMocks();
  processorOnline.mockResolvedValue(true);
  dom = new JSDOM("<div id='root'></div>");
  originals = {};
  for (const name of [
    "window",
    "document",
    "navigator",
    "CustomEvent",
    "File",
    "FileReader",
    "FormData",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    originals[name] = Object.getOwnPropertyDescriptor(global, name);
    Object.defineProperty(global, name, {
      configurable: true,
      writable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  }
  root = createRoot(document.getElementById("root"));
  workspaceApi.getParsedFiles.mockResolvedValue({
    files: [],
    currentContextTokenCount: 0,
    contextWindow: 100,
  });
  workspaceApi.parseFile.mockResolvedValue(parsed);
  workspaceApi.deleteParsedFiles.mockResolvedValue({});
  workspaceApi.embedParsedFile.mockResolvedValue({
    response: { ok: true },
    data: {},
  });
});

it("disables attachment selection until the document processor is ready", async () => {
  const health = deferred();
  processorOnline.mockReturnValue(health.promise);
  await act(async () =>
    root.render(
      React.createElement(
        DnDFileUploaderProvider,
        { workspace: { slug: "one" } },
        React.createElement(
          DnDWrapper,
          null,
          React.createElement(attachOutput.exports.default, {
            workspaceSlug: "one",
          })
        )
      )
    )
  );
  expect(document.getElementById("attach-item-btn").disabled).toBe(true);
  expect(document.getElementById("dnd-chat-file-uploader").disabled).toBe(true);
  await act(async () => health.resolve(true));
  expect(document.getElementById("attach-item-btn").disabled).toBe(false);
  expect(document.getElementById("dnd-chat-file-uploader").disabled).toBe(
    false
  );
});

it("keeps attachment selection disabled when the processor is offline", async () => {
  processorOnline.mockResolvedValue(false);
  await act(async () =>
    root.render(
      React.createElement(
        DnDFileUploaderProvider,
        { workspace: { slug: "one" } },
        React.createElement(
          DnDWrapper,
          null,
          React.createElement(attachOutput.exports.default, {
            workspaceSlug: "one",
          })
        )
      )
    )
  );
  expect(document.getElementById("attach-item-btn").disabled).toBe(true);
  expect(document.getElementById("dnd-chat-file-uploader").disabled).toBe(true);
});

it("waits for the new conversation's health check instead of an old completion", async () => {
  const oldHealth = deferred();
  const newHealth = deferred();
  processorOnline
    .mockReturnValueOnce(oldHealth.promise)
    .mockReturnValueOnce(newHealth.promise);
  const renderPicker = (slug) =>
    act(async () =>
      root.render(
        React.createElement(
          DnDFileUploaderProvider,
          { workspace: { slug } },
          React.createElement(
            DnDWrapper,
            null,
            React.createElement(attachOutput.exports.default, {
              workspaceSlug: slug,
            })
          )
        )
      )
    );
  await renderPicker("one");
  await renderPicker("two");
  await act(async () => oldHealth.resolve(true));
  expect(document.getElementById("attach-item-btn").disabled).toBe(true);
  await act(async () => newHealth.resolve(true));
  expect(document.getElementById("attach-item-btn").disabled).toBe(false);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await act(async () => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(global, name, descriptor);
    else delete global[name];
  }
});

it.each([
  ["one", "thread-two"],
  ["two", null],
])("does not carry attachments into %s/%s", async (slug, thread) => {
  await render();
  await act(async () =>
    context.onDrop([new File(["hi"], "doc.txt", { type: "text/plain" })])
  );
  expect(context.files).toHaveLength(1);
  await render(slug, thread);
  expect(context.files).toHaveLength(0);
});

it("retains attachments on a rerender of the same conversation", async () => {
  await render();
  await act(async () =>
    context.onDrop([new File(["hi"], "doc.txt", { type: "text/plain" })])
  );
  await render();
  expect(context.files).toHaveLength(1);
});

it("paste and remove listeners target the new workspace after navigation", async () => {
  await render();
  await render("two", "new-thread");
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent("ATTACHMENT_PASTED", {
        detail: {
          files: [new File(["hi"], "doc.txt", { type: "text/plain" })],
        },
      })
    )
  );
  expect(workspaceApi.getParsedFiles).toHaveBeenLastCalledWith(
    "two",
    "new-thread"
  );
  expect(workspaceApi.parseFile.mock.calls[0][0]).toBe("two");
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent("ATTACHMENT_REMOVE", {
        detail: { uid: context.files[0].uid, document: { location: "doc" } },
      })
    )
  );
  expect(workspaceApi.deleteAndUnembedFile).toHaveBeenCalledWith("two", "doc");
});

it("does not start parsing after an old conversation's context lookup finishes", async () => {
  const lookup = deferred();
  workspaceApi.getParsedFiles.mockReturnValueOnce(lookup.promise);
  await render();
  await act(async () =>
    context.onDrop([new File(["hi"], "doc.txt", { type: "text/plain" })])
  );
  await render("two");
  await act(async () =>
    lookup.resolve({ currentContextTokenCount: 0, contextWindow: 100 })
  );
  expect(workspaceApi.parseFile).not.toHaveBeenCalled();
});

it("an old upload finishing cannot unlock the next conversation's send button", async () => {
  const upload = deferred();
  workspaceApi.parseFile.mockReturnValueOnce(upload.promise);
  await render();
  await act(async () =>
    context.onDrop([new File(["hi"], "doc.txt", { type: "text/plain" })])
  );
  await render("two");
  const processed = jest.fn();
  window.addEventListener(ATTACHMENTS_PROCESSED_EVENT, processed);
  await act(async () => upload.resolve(parsed));
  expect(processed).not.toHaveBeenCalled();
  expect(context.files).toHaveLength(0);
});

it.each(["onClose", "onEmbed"])(
  "late modal %s completion does not affect a new conversation",
  async (action) => {
    workspaceApi.getParsedFiles.mockResolvedValue({
      currentContextTokenCount: 100,
      contextWindow: 100,
    });
    await render();
    await act(async () =>
      context.onDrop([new File(["hi"], "doc.txt", { type: "text/plain" })])
    );
    expect(modal.show).toBe(true);
    const operation = deferred();
    workspaceApi[
      action === "onClose" ? "deleteParsedFiles" : "embedParsedFile"
    ].mockReturnValueOnce(operation.promise);
    let completion;
    await act(async () => {
      completion = modal[action]();
    });
    await render("two");
    const processed = jest.fn();
    window.addEventListener(ATTACHMENTS_PROCESSED_EVENT, processed);
    await act(async () => {
      operation.resolve({ response: { ok: true }, data: {} });
      await completion;
    });
    expect(processed).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  }
);
