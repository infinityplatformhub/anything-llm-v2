/* global jest */
const { it, expect } = require("@jest/globals");
require("../../utils/lark/_polyfill");
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
const AIbitat = require("../../../utils/agents/aibitat");
it("sanitizes private-context provider failures instead of logging echoed tool results", async () => {
  const instance = new AIbitat({
    handlerProps: { invocation: { personalMcpUsed: true }, log: jest.fn() },
  });
  const provider = {
    resetCumulativeUsage: jest.fn(),
    complete: jest.fn().mockRejectedValue(new Error("private-echoed-result")),
  };
  Object.defineProperty(instance, "providerInstance", { get: () => provider });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(instance.handleExecution()).rejects.toThrow(
    "The agent model failed to respond"
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-echoed-result");
  log.mockRestore();
});
it.each(["handleExecution", "handleAsyncExecution"])(
  "actual %s never emits private args/results to generic trace listeners or introspection",
  async (method) => {
    const instance = new AIbitat({
      handlerProps: { invocation: {}, log: jest.fn() },
    });
    const completion = {
      functionCall: {
        name: "personal-read",
        arguments: { secret: "private-args" },
      },
    };
    const provider = {
      verbose: true,
      resetCumulativeUsage: jest.fn(),
      getCumulativeUsage: () => ({}),
      complete: jest
        .fn()
        .mockResolvedValueOnce(completion)
        .mockResolvedValueOnce({
          functionCall: {
            name: "legacy-consume",
            arguments: { secret: "private-result" },
          },
        })
        .mockResolvedValue({ textResponse: "safe-final" }),
      stream: jest
        .fn()
        .mockResolvedValueOnce(completion)
        .mockResolvedValueOnce({
          functionCall: {
            name: "legacy-consume",
            arguments: { secret: "private-result" },
          },
        })
        .mockResolvedValue({ textResponse: "safe-final" }),
    };
    Object.defineProperty(instance, "providerInstance", {
      get: () => provider,
    });
    instance.introspect = jest.fn();
    const traces = jest.fn();
    instance.emitter.on("toolCallResult", traces);
    instance.function({
      name: "legacy-consume",
      handler: async () => "private-result",
    });
    instance.function({
      name: "personal-read",
      privateMcp: true,
      handler: async () => {
        instance.personalMcpUsed = true;
        return "private-result";
      },
    });
    expect(await instance[method]([], [{}], "@agent")).toBe("safe-final");
    expect(traces).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        instance.handlerProps.log.mock.calls,
        instance.introspect.mock.calls,
      ])
    ).not.toMatch(/private-args|private-result/);
  }
);
