const { attached, since } = require("./evidence");

// The JWT/UI chat path only creates the invocation and returns its uuid over SSE.
// The AgentHandler — and therefore every skill attach — runs when
// /api/agent-invocation/:uuid is opened. A test asserting on attaches from that
// path must open the socket, or nothing ever attaches and the assertion passes
// for the wrong reason.
const websocketUUID = (response) => {
  for (const line of response.body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const chunk = JSON.parse(line.slice(6));
    if (chunk.type === "agentInitWebsocketConnection") return chunk.websocketUUID;
  }
  return null;
};

// Positive control for the JWT path: the agent cluster finished attaching every
// plugin and reached the LLM. Skill attaches are logged before this line, so a
// "not attached" assertion read after it is a real observation, not a race.
// Matches both the streaming and non-streaming provider branches.
const AGENT_REACHED_MODEL = (chunk) =>
  chunk.includes("agent streaming - will use");

// Positive control when a skill is expected to attach.
const AGENT_ATTACHED = (name) => (chunk) => attached(chunk, name);

/**
 * Open the agent invocation socket and wait until `ready(logChunk)` holds, the
 * socket closes, or 60s elapse.
 */
async function driveAgentWebsocket(baseUrl, logFile, uuid, logMark, ready) {
  const url = new URL(baseUrl);
  const socket = new WebSocket(
    `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/api/agent-invocation/${uuid}`
  );
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (!ready(since(logFile, logMark))) return;
      clearTimeout(timeout);
      clearInterval(poll);
      socket.close();
      resolve();
    }, 100);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      socket.close();
      reject(new Error("agent websocket timed out"));
    }, 60_000);
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      clearInterval(poll);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(new Error("agent websocket failed"));
    });
  });
}

module.exports = {
  websocketUUID,
  driveAgentWebsocket,
  AGENT_REACHED_MODEL,
  AGENT_ATTACHED,
};
