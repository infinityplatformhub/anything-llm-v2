const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../utils/http", () => ({
  userFromSession: async (_request, response) => response.locals.user,
  multiUserMode: (response) => response.locals.multiUserMode,
  safeJsonParse: (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next(),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: () => (_request, _response, next) => next(),
  ROLES: { all: "<all>" },
}));
jest.mock("../../models/workspaceChats", () => ({
  WorkspaceChats: { _update: jest.fn(), where: jest.fn() },
}));
jest.mock("../../models/workspace", () => ({
  Workspace: { where: jest.fn(), whereWithUser: jest.fn() },
}));
jest.mock("../../models/scheduledJobRun", () => ({
  ScheduledJobRun: { where: jest.fn() },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn().mockResolvedValue() },
}));

const { WorkspaceChats } = require("../../models/workspaceChats");
const { Workspace } = require("../../models/workspace");
const { ScheduledJobRun } = require("../../models/scheduledJobRun");
const createFiles = require("../../utils/agents/aibitat/plugins/create-files/lib");
const {
  CreateTextFile,
} = require("../../utils/agents/aibitat/plugins/create-files/text/create-text-file");
const { agentFileServerEndpoints } = require("../../endpoints/agentFileServer");

let download;
let chat;
let agent;
let handler;
let storage;
let previousStorage;

async function requestFile(filename, multiUserMode = false) {
  const response = {
    locals: { user: { id: 7, role: "default" }, multiUserMode },
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  await download({ params: { filename } }, response);
  return response;
}

beforeAll(() => {
  previousStorage = process.env.STORAGE_DIR;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "agent-file-download-"));
  process.env.STORAGE_DIR = storage;
  agentFileServerEndpoints({
    get: (route, _middlewares, callback) => {
      if (route.startsWith("/agent-skills/")) download = callback;
    },
  });
});

afterAll(() => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  fs.rmSync(storage, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  chat = { id: 42, workspaceId: 5, include: false, response: "{}" };
  Workspace.where.mockResolvedValue([{ id: 5 }]);
  Workspace.whereWithUser.mockResolvedValue([{ id: 5 }]);
  WorkspaceChats.where.mockImplementation(async (filter) =>
    filter.workspaceId.in.includes(chat.workspaceId) &&
    chat.response.includes(filter.response.contains)
      ? [chat]
      : []
  );
  WorkspaceChats._update.mockImplementation(async (_id, data) => {
    Object.assign(chat, data);
    return true;
  });
  ScheduledJobRun.where.mockResolvedValue([]);
  agent = {
    trackedChatId: chat.id,
    handlerProps: { log: jest.fn() },
    introspect: jest.fn(),
    socket: { send: jest.fn() },
    function(config) {
      handler = config.handler.bind(config);
    },
  };
  CreateTextFile.plugin().setup(agent);
});

test("a file is downloadable as soon as its live card is published", async () => {
  let immediateDownload;
  agent.socket.send.mockImplementation((_type, payload) => {
    immediateDownload = requestFile(payload.storageFilename);
  });

  await handler({ filename: "report.csv", content: "Title,Sales\nNovel,50" });

  const result = await immediateDownload;
  expect(result.statusCode).toBe(200);
  expect(result.body.toString()).toBe("Title,Sales\nNovel,50");
  expect(chat.include).toBe(false);
  expect(JSON.parse(chat.response).text).toBeUndefined();
  expect(result.headers["Content-Disposition"]).toContain("report.csv");
});

test("does not publish the card while the chat reference is still being saved", async () => {
  let finishUpdate;
  const updating = new Promise((resolve) => {
    WorkspaceChats._update.mockImplementationOnce(async (_id, data) => {
      resolve();
      await new Promise((done) => (finishUpdate = done));
      Object.assign(chat, data);
      return true;
    });
  });
  const creating = handler({ filename: "pending.txt", content: "data" });
  await updating;
  expect(agent.socket.send).not.toHaveBeenCalled();
  finishUpdate();
  await creating;
  expect(agent.socket.send).toHaveBeenCalledTimes(1);
});

test("preserves earlier outputs and supports multiple files in one reply", async () => {
  const earlier = { type: "imageGenerationCard", payload: { prompt: "chart" } };
  agent._pendingOutputs = [earlier];
  await handler({ filename: "first.txt", content: "one" });
  await handler({ filename: "second.txt", content: "two" });

  expect(JSON.parse(chat.response).outputs).toEqual(agent._pendingOutputs);
  expect(agent._pendingOutputs[0]).toEqual(earlier);
  for (const [, payload] of agent.socket.send.mock.calls) {
    expect((await requestFile(payload.storageFilename)).statusCode).toBe(200);
  }
});

test("reports a failed chat update without publishing an unusable card", async () => {
  WorkspaceChats._update.mockResolvedValueOnce(false);
  const result = await handler({ filename: "failed.txt", content: "data" });
  expect(result).toMatch(/Error creating text file/);
  expect(agent.socket.send).not.toHaveBeenCalled();
});

test("ephemeral agents still collect outputs without a reserved chat", async () => {
  delete agent.trackedChatId;
  await handler({ filename: "scheduled.txt", content: "data" });
  expect(WorkspaceChats._update).not.toHaveBeenCalled();
  expect(agent._pendingOutputs).toHaveLength(1);
  expect(agent.socket.send).toHaveBeenCalledTimes(1);
});

test("serves historical files but denies files in inaccessible workspaces", async () => {
  await handler({ filename: "historical.txt", content: "saved" });
  const filename = agent._pendingOutputs[0].payload.storageFilename;
  chat.include = true;
  chat.response = JSON.stringify({
    text: "Your file is ready.",
    outputs: agent._pendingOutputs,
  });
  expect((await requestFile(filename, true)).statusCode).toBe(200);
  Workspace.whereWithUser.mockResolvedValueOnce([{ id: 99 }]);
  expect((await requestFile(filename, true)).statusCode).toBe(404);
  expect(ScheduledJobRun.where).not.toHaveBeenCalled();
});

test("cleared history and deleted files remain unavailable", async () => {
  await handler({ filename: "deleted.txt", content: "data" });
  const filename = agent._pendingOutputs[0].payload.storageFilename;
  chat.response = JSON.stringify({
    text: "Done",
    outputs: agent._pendingOutputs,
  });
  expect((await requestFile(filename)).statusCode).toBe(404);
  chat.include = true;
  fs.unlinkSync(path.join(storage, "generated-files", filename));
  expect((await requestFile(filename)).body.error).toBe(
    "File not found in storage"
  );
});
