const { SystemSettings } = require("../../models/systemSettings");
const { isLarkLoginEnabled } = require("../lark/settings");

async function larkLoginEnabled(_, response, next) {
  if (!(await SystemSettings.isMultiUserMode()))
    return response
      .status(403)
      .send("Multi-User mode is required for Lark login.");

  if (!(await isLarkLoginEnabled()))
    return response.status(403).send("Lark login is not enabled.");

  next();
}

module.exports = { larkLoginEnabled };
