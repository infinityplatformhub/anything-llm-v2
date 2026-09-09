const { Telemetry } = require("../models/telemetry");
const {
  WorkspaceAgentInvocation,
} = require("../models/workspaceAgentInvocation");
const { AgentHandler } = require("../utils/agents");
const {
  WEBSOCKET_BAIL_COMMANDS,
} = require("../utils/agents/aibitat/plugins/websocket");
const { safeJsonParse } = require("../utils/http");

/**
 * Runs one socket message handler with both of its failure modes contained.
 * `ws` calls the "message" listener from an EventEmitter, so a synchronous
 * throw out of here becomes an `uncaughtException`, and a rejected promise
 * returned from an async handler becomes an `unhandledRejection` - either one
 * kills the whole server process under Node's default
 * `--unhandled-rejections=throw`. The handlers run on raw client input and not
 * all of them parse it defensively (the websocket plugin's `handleFeedback`
 * opens with a bare `JSON.parse`), so a bad frame must not travel past here.
 * @param {function} handler - the socket handler to invoke
 * @param {string} name - handler name, for the log line
 * @param {*} message - the raw frame from the client
 * @returns {*} the handler's return value, or undefined when it threw
 */
function runMessageHandler(handler, name, message) {
  const report = (error) =>
    console.error(`[agentWebsocket] ${name} failed on client input:`, error);
  try {
    const result = handler(message);
    if (typeof result?.then === "function") result.catch(report);
    return result;
  } catch (error) {
    report(error);
  }
}

// Setup listener for incoming messages to relay to socket so it can be handled by agent plugin.
function relayToSocket(message) {
  // Tool toggles can arrive while the agent is paused awaiting feedback/approval,
  // so handle them first. The handler ignores (returns false for) any other message.
  if (
    this.handleToolToggle &&
    runMessageHandler(this.handleToolToggle, "handleToolToggle", message)
  )
    return;
  if (this.handleFeedback)
    return runMessageHandler(this.handleFeedback, "handleFeedback", message);
  if (this.handleToolApproval)
    return runMessageHandler(
      this.handleToolApproval,
      "handleToolApproval",
      message
    );
  if (this.handleClarificationResponse)
    return runMessageHandler(
      this.handleClarificationResponse,
      "handleClarificationResponse",
      message
    );
  runMessageHandler(this.checkBailCommand, "checkBailCommand", message);
}

function agentWebsocket(app) {
  if (!app) return;

  app.ws("/agent-invocation/:uuid", async function (socket, request) {
    try {
      const agentHandler = await new AgentHandler({
        uuid: String(request.params.uuid),
      }).init();

      if (!agentHandler.invocation) {
        socket.close();
        return;
      }

      // Installed before the "message" listener: a frame that arrives in
      // between would otherwise reach relayToSocket with no bail handler set.
      socket.checkBailCommand = (data) => {
        const content = safeJsonParse(data)?.feedback;
        if (WEBSOCKET_BAIL_COMMANDS.includes(content)) {
          agentHandler.log(
            `User invoked bail command while processing. Closing session now.`
          );
          // aibitat may not exist yet if the bail arrives while the session
          // is still being built - closing the socket alone is enough then.
          agentHandler.aibitat?.abort();
          socket.close();
          return;
        }
      };

      socket.on("message", relayToSocket);
      socket.on("close", () => {
        // Abort the running agent loop (stop button, tab close, disconnect) so
        // in-flight LLM requests are cancelled and no further turns run.
        agentHandler.aibitat?.abort();
        agentHandler.closeAlert();
        WorkspaceAgentInvocation.close(String(request.params.uuid));
        return;
      });

      // Defence in depth. The primary guard is at the express-ws bootstrap
      // (utils/boot/bootWebSockets.js), which covers every socket the server
      // makes - including the unauthenticated, route-less ones this listener can
      // never see. BE CLEAR ABOUT WHAT THIS ADDS: with that guard in place this
      // listener is not what keeps the process alive, and removing it alone
      // leaves every test green. It is kept so this route stays safe on its own
      // terms if it is ever mounted on a ws server booted some other way, and so
      // the log names the invocation rather than only the path.
      socket.on("error", (error) => {
        console.error(
          `[agentWebsocket] Socket error on invocation ${String(request.params.uuid)}:`,
          error
        );
        socket.close();
      });

      await Telemetry.sendTelemetry("agent_chat_started");
      await agentHandler.createAIbitat({ socket });
      // Socket can close while aibitat is being built - don't start a session nobody is listening to.
      if (socket.readyState !== socket.OPEN) return;
      await agentHandler.startAgentCluster();
    } catch (e) {
      console.error(e.message, e);
      socket?.send(JSON.stringify({ type: "wssFailure", content: e.message }));
      socket?.close();
    }
  });
}

module.exports = { agentWebsocket };
