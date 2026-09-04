const { LarkIdentity } = require("../../../../models/larkIdentity");
const { SystemSettings } = require("../../../../models/systemSettings");
const {
  checkPolicy,
  classify,
  runAsUser,
  validateArgs,
} = require("../../../lark/cli");
const {
  isLarkLoginEnabled,
  loadLarkConfig,
} = require("../../../lark/settings");

const NOT_CONNECTED =
  "Lark is not connected for this user. Connect Lark in Settings.";

function approvalCommand(args) {
  let expectsValue = false;
  return args
    .map((arg, index) => {
      if (index < 2) return arg;
      if (expectsValue) {
        expectsValue = false;
        return "[redacted]";
      }
      if (arg.startsWith("-")) {
        const equals = arg.indexOf("=");
        if (equals > 0) return `${arg.slice(0, equals)}=[redacted]`;
        expectsValue = true;
        return arg;
      }
      return "[redacted]";
    })
    .join(" ");
}

const larkCli = {
  name: "lark-cli",
  startupConfig: { params: {} },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        const userId = aibitat.handlerProps?.invocation?.user_id;
        if (userId == null) {
          aibitat.handlerProps?.log?.(
            "lark-cli unavailable: invocation has no user_id"
          );
          return;
        }

        let loggedUnavailable = false;
        const unavailable = () => {
          if (!loggedUnavailable) {
            aibitat.handlerProps?.log?.(
              `lark-cli unavailable for user ${userId}`
            );
            loggedUnavailable = true;
          }
          return NOT_CONNECTED;
        };

        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            'Run Lark commands as the connected user. Use canonical forms: contact +search-user --query "<email or name>", im +messages-send --user-id ou_xxx --text "...", and docs +fetch --doc "<url or token>". Write commands require the user\'s approval.',
          examples: [
            {
              prompt: "Find Pat in Lark contacts",
              call: JSON.stringify({
                args: ["contact", "+search-user", "--query", "Pat"],
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              args: {
                type: "array",
                description: "Canonical Lark command arguments.",
                items: { type: "string" },
                minItems: 1,
              },
            },
            required: ["args"],
            additionalProperties: false,
          },
          handler: async function ({ args }) {
            let config;
            let identity;
            try {
              if (!(await SystemSettings.isMultiUserMode()))
                return unavailable();
              if (!(await isLarkLoginEnabled())) return unavailable();

              [config, identity] = await Promise.all([
                loadLarkConfig(),
                LarkIdentity.get({ user_id: userId }),
              ]);
              if (
                !config?.enabled ||
                !config.appId ||
                !config.appSecret ||
                !config.tenantKey ||
                !identity ||
                identity.needs_reauth
              )
                return unavailable();
            } catch {
              return unavailable();
            }

            const validation = validateArgs(args);
            if (!validation.ok) return validation.reason;

            const policy = checkPolicy(args, config.allowlist);
            if (!policy.allowed) return policy.reason;

            const effect = classify(args);
            if (effect === "write") {
              if (typeof aibitat.requestToolApproval !== "function")
                return "Lark command was not approved.";

              const approval = await aibitat.requestToolApproval({
                skillName: "lark-cli",
                payload: { command: args.join(" ") },
                description: `Run Lark command as you: ${approvalCommand(args)} (${effect})`,
              });
              if (!approval?.approved) return "Lark command was not approved.";
            }

            const result = await runAsUser({ userId, args });
            return result.ok ? JSON.stringify(result.data) : result.error;
          },
        });
      },
    };
  },
};

module.exports = { larkCli };
