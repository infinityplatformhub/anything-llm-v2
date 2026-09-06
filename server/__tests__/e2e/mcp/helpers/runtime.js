const path = require("path");
const Layer = require(path.join(process.env.E2E_SERVER_SOURCE, "utils/MCP"));
const layer = new Layer();
process.on("message", async ({ id, method, workspace }) => {
  try {
    let result;
    if (method === "active") result = await layer.activeMCPServers(workspace);
    else if (method === "call")
      result = await layer.callWorkspaceTool(workspace, "flowaccount", {
        name: "get_company_info",
        arguments: {},
      });
    else throw new Error("Unknown runtime operation");
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
