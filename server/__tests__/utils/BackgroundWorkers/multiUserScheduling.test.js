jest.mock("@ladjs/graceful", () =>
  jest.fn().mockImplementation(() => ({ listen() {}, stopBree() {} }))
);
jest.mock("@mintplex-labs/bree", () =>
  jest.fn().mockImplementation(() => ({ start() {} }))
);
jest.mock("../../../utils/logger", () => () => ({ info() {}, error() {} }));
jest.mock("../../../models/documentSyncQueue", () => ({
  DocumentSyncQueue: { enabled: async () => false },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(),
    autoMemoriesEnabled: async () => false,
  },
}));
jest.mock("../../../models/scheduledJob", () => ({
  ScheduledJob: {
    allEnabled: async () => [{ id: 42, name: "test", schedule: "* * * * *" }],
    recomputeNextRunAt: async () => {},
  },
}));
jest.mock("../../../models/scheduledJobRun", () => ({
  ScheduledJobRun: {
    failOrphanedRuns: async () => 0,
    start: jest.fn().mockResolvedValue(null),
  },
}));

const { BackgroundService } = require("../../../utils/BackgroundWorkers");
const { SystemSettings } = require("../../../models/systemSettings");
const { ScheduledJobRun } = require("../../../models/scheduledJobRun");
const later = require("@breejs/later");

let service;
let timer;
let callback;
beforeEach(() => {
  jest.clearAllMocks();
  BackgroundService._instance = null;
  service = new BackgroundService();
  timer = { clear: jest.fn() };
  jest.spyOn(later, "setInterval").mockImplementation((fn) => {
    callback = fn;
    return timer;
  });
});
afterEach(async () => {
  await service.stop();
  jest.restoreAllMocks();
  BackgroundService._instance = null;
});

it("does not register scheduled timers when booting in multi-user mode", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  await service.boot();
  expect(later.setInterval).not.toHaveBeenCalled();
});

it("clears an old single-user timer without claiming a run after switching modes", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(false);
  await service.boot();
  expect(later.setInterval).toHaveBeenCalledTimes(1);
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  callback();
  await new Promise(setImmediate);
  expect(timer.clear).toHaveBeenCalledTimes(1);
  expect(ScheduledJobRun.start).not.toHaveBeenCalled();
});

it("keeps single-user enqueue and deduplication behavior", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(false);
  await service.boot();
  expect(await service.enqueueScheduledJob(42)).toBeNull();
  expect(ScheduledJobRun.start).toHaveBeenCalledWith(42);
});

it("rejects a manual enqueue in multi-user mode before claiming a database run", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  expect(await service.enqueueScheduledJob(42)).toBeNull();
  expect(ScheduledJobRun.start).not.toHaveBeenCalled();
});
