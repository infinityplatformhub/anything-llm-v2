const { Workspace } = require("../models/workspace");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const { Document } = require("../models/documents");
const {
  validBrowserExtensionApiKey,
} = require("../utils/middleware/validBrowserExtensionApiKey");
const { CollectorApi } = require("../utils/collectorApi");
const { reqBody, multiUserMode, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { Telemetry } = require("../models/telemetry");
const registry = require("../utils/browserCompanion/registry");
const protocol = require("../utils/browserCompanion/protocol");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");

// WebSocket close codes. True constants, not deployment settings: 4000-4999 is
// the range RFC 6455 reserves for the application, and the extension switches on
// these numbers to decide what to show the user. Changing one is a wire-protocol
// change for the extension, not a config change.
const WS_CLOSE_UNAUTHORIZED = 4401; // no key, or the key is not valid
const WS_CLOSE_FORBIDDEN = 4403; // key is valid but its user may not connect
const WS_CLOSE_REPLACED = 4409; // another device took this user's slot
const WS_CLOSE_INTERNAL_ERROR = 1011; // RFC 6455 "internal error"

// ws refuses a close reason over 123 bytes with a throw ("The message must not be
// greater than 123 bytes"), verified against ws@7.5.10. Kept well under.
const EVICTED_REASON = "Replaced by a newer connection.";

function browserExtensionEndpoints(app) {
  if (!app) return;

  app.get(
    "/browser-extension/check",
    [validBrowserExtensionApiKey],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaces = multiUserMode(response)
          ? await Workspace.whereWithUser(user)
          : await Workspace.where();

        const apiKeyId = response.locals.apiKey.id;
        response.status(200).json({
          connected: true,
          workspaces,
          apiKeyId,
        });
      } catch (error) {
        console.error(error);
        response
          .status(500)
          .json({ connected: false, error: "Failed to fetch workspaces" });
      }
    }
  );

  app.delete(
    "/browser-extension/disconnect",
    [validBrowserExtensionApiKey],
    async (_request, response) => {
      try {
        const apiKeyId = response.locals.apiKey.id;
        const { success, error } =
          await BrowserExtensionApiKey.delete(apiKeyId);
        if (!success) throw new Error(error);
        response.status(200).json({ success: true });
      } catch (error) {
        console.error(error);
        response
          .status(500)
          .json({ error: "Failed to disconnect and revoke API key" });
      }
    }
  );

  app.get(
    "/browser-extension/workspaces",
    [validBrowserExtensionApiKey],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaces = multiUserMode(response)
          ? await Workspace.whereWithUser(user)
          : await Workspace.where();

        response.status(200).json({ workspaces });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: "Failed to fetch workspaces" });
      }
    }
  );

  app.post(
    "/browser-extension/embed-content",
    [validBrowserExtensionApiKey],
    async (request, response) => {
      try {
        const { workspaceId, textContent, metadata } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { id: parseInt(workspaceId) })
          : await Workspace.get({ id: parseInt(workspaceId) });

        if (!workspace) {
          response.status(404).json({ error: "Workspace not found" });
          return;
        }

        const Collector = new CollectorApi();
        const { success, reason, documents } = await Collector.processRawText(
          textContent,
          metadata
        );

        if (!success) {
          response.status(500).json({ success: false, error: reason });
          return;
        }

        const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
          workspace,
          [documents[0].location],
          user?.id
        );

        if (failedToEmbed.length > 0) {
          response.status(500).json({ success: false, error: errors[0] });
          return;
        }

        await Telemetry.sendTelemetry("browser_extension_embed_content");
        response.status(200).json({ success: true });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: "Failed to embed content" });
      }
    }
  );

  app.post(
    "/browser-extension/upload-content",
    [validBrowserExtensionApiKey],
    async (request, response) => {
      try {
        const { textContent, metadata } = reqBody(request);
        const Collector = new CollectorApi();
        const { success, reason } = await Collector.processRawText(
          textContent,
          metadata
        );

        if (!success) {
          response.status(500).json({ success: false, error: reason });
          return;
        }

        await Telemetry.sendTelemetry("browser_extension_upload_content");
        response.status(200).json({ success: true });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: "Failed to embed content" });
      }
    }
  );

  // Internal endpoints for managing API keys
  app.get(
    "/browser-extension/api-keys",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const apiKeys = multiUserMode(response)
          ? await BrowserExtensionApiKey.whereWithUser(user)
          : await BrowserExtensionApiKey.where();

        response.status(200).json({ success: true, apiKeys });
      } catch (error) {
        console.error(error);
        response
          .status(500)
          .json({ success: false, error: "Failed to fetch API keys" });
      }
    }
  );

  app.post(
    "/browser-extension/api-keys/new",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { apiKey, error } = await BrowserExtensionApiKey.create(
          user?.id || null
        );
        if (error) throw new Error(error);
        response.status(200).json({
          apiKey: apiKey.key,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: "Failed to create API key" });
      }
    }
  );

  app.delete(
    "/browser-extension/api-keys/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const user = await userFromSession(request, response);

        if (multiUserMode(response) && user.role !== ROLES.admin) {
          const apiKey = await BrowserExtensionApiKey.get({
            id: parseInt(id),
            user_id: user?.id,
          });
          if (!apiKey) {
            return response.status(403).json({ error: "Unauthorized" });
          }
        }

        const { success, error } = await BrowserExtensionApiKey.delete(id);
        if (!success) throw new Error(error);
        response.status(200).json({ success: true });
      } catch (error) {
        console.error(error);
        response.status(500).json({ error: "Failed to revoke API key" });
      }
    }
  );

  // Long-lived socket the extension holds open so agent tools can drive the
  // user's own Chrome. Browser WebSocket cannot set headers, so the key travels
  // as a query param — the same key /browser-extension/check accepts as a bearer.
  //
  // This handler is the authentication boundary for the whole feature: everything
  // behind it (the registry entry, every command the protocol writes to this
  // socket) trusts that whoever holds this socket is the user identified here.
  // The only identity that may reach `registry.register` is `apiKey.user_id` from
  // the validated `browser_extension_api_keys` row — never anything off the
  // request, which is attacker-controlled.
  app.ws("/browser-companion/agent-socket", async function (socket, request) {
    try {
      const key = request?.query?.key;
      // String(key) below would turn a missing key into "undefined" and a
      // repeated ?key=a&key=b (express parses that to an array) into "a,b" — both
      // reach the DB as a lookup that simply misses, but neither should get that
      // far. Only a non-empty string is a candidate for validation.
      if (!key || typeof key !== "string")
        return socket.close(WS_CLOSE_UNAUTHORIZED);

      // `validate` resolves `false` (not null) for a bad key, and already applies
      // the multi-user rule that a key with no user_id is not valid. Checked
      // falsy rather than `=== null` so both spellings close the socket.
      const apiKey = await BrowserExtensionApiKey.validate(key);
      if (!apiKey) return socket.close(WS_CLOSE_UNAUTHORIZED);

      const multiUserMode = await SystemSettings.isMultiUserMode();
      if (multiUserMode) {
        // Defence in depth: `validate` already rejects a null user_id in
        // multi-user mode, but this endpoint must not depend on that staying
        // true — registry.register would otherwise bind this connection to the
        // legacy single-user key, which every user's agent run can resolve.
        if (apiKey.user_id === null) return socket.close(WS_CLOSE_FORBIDDEN);
        const user = await User.get({ id: apiKey.user_id });
        if (!user || user.suspended) return socket.close(WS_CLOSE_FORBIDDEN);
      }

      // The socket object registered here is the same object handed to
      // `protocol.attach` below and the same one `registry.resolve` returns to
      // task 4. protocol.js keys its pending map on socket identity, so wrapping
      // or re-creating it between these two calls would make every reply stop
      // matching and every command time out.
      const { evicted } = registry.register({
        userId: apiKey.user_id,
        socket,
      });
      if (evicted) {
        // The replaced device must know why it went quiet — a silent drop reads
        // as a bug to whoever is watching that popup. `register` hands the
        // displaced socket back but does not close it; closing it is this
        // handler's job, or the evicted extension keeps a half-open connection
        // the server no longer routes to and shows a browser that looks
        // connected and never answers.
        try {
          // Order matters and is verified against ws@7.5.10: a frame sent after
          // close() is silently dropped (readyState is already CLOSING), so the
          // evicted device would receive nothing at all. Send first, then close.
          evicted.send(
            JSON.stringify({ event: "evicted", reason: EVICTED_REASON })
          );
          evicted.close(WS_CLOSE_REPLACED, EVICTED_REASON);
        } catch (error) {
          // Already gone — nothing to tell. Logged rather than swallowed: a
          // throw here that is not the expected dead-socket case (an
          // unstringifiable frame, a socket with no usable send) would otherwise
          // leave no trace, and the eviction still has to proceed either way.
          console.error(
            "browser-companion: could not notify the evicted socket",
            error
          );
        }
      }

      protocol.attach(socket);

      // Socket-identity wiring check, at connect time rather than at reply time.
      //
      // protocol.js keys its pending map on the socket OBJECT, so if the object
      // registered above is ever not the object attached here — a wrapper, a
      // proxy, a spread copy, a prototype alias — every reply stops matching and
      // every command times out with text identical to a disconnected browser.
      // Nothing logs, and the cause is one function away from the symptom.
      //
      // This cannot be detected from the reply path outside protocol.js: an
      // unknown requestId and a known-but-mismatched one both leave
      // `__pendingCount` unchanged, because `handleMessage` returns identically
      // for both and the distinction never crosses the module boundary. It CAN
      // be detected here, before a single command is sent, because the invariant
      // is simply that these are the same object. So the check lives where the
      // plumbing does. It is a wiring bug or an attack, never normal traffic, so
      // it cannot be noisy: on a correct build it never fires.
      const registered = registry.resolve({
        userId: apiKey.user_id,
        multiUserMode,
      }).socket;
      if (registered !== socket) {
        console.error(
          "browser-companion: socket identity mismatch between registry and protocol — every command on this connection would time out. Refusing the connection.",
          { userId: apiKey.user_id }
        );
        // Fail closed and loudly. A connection in this state is not merely
        // degraded: it is a browser the user sees as connected that can never
        // answer. Better to refuse it than to serve a socket that silently
        // swallows every command.
        registry.unregister({ userId: apiKey.user_id, socket });
        return socket.close(WS_CLOSE_INTERNAL_ERROR);
      }

      // ws emits 'error' on the socket for any protocol violation in an inbound
      // frame — an invalid opcode is enough. Verified against ws@7.5.10: with no
      // 'error' listener, Node's EventEmitter rethrows and takes the ENTIRE
      // server process down. The extension is untrusted network input, so this
      // listener is what keeps one malformed frame from being a remote crash.
      // ws closes the connection itself afterwards, so the close handler below
      // still runs and still unregisters.
      socket.on("error", (error) => {
        console.error("browser-companion socket error", error);
      });

      socket.on("close", () => {
        // Runs for every close, including abnormal ones (verified against
        // ws@7.5.10: a destroyed TCP connection still emits 'close', code 1006).
        // Missing one would leak the registry entry and keep routing commands to
        // a dead socket. `unregister` only drops the entry while it is still this
        // socket, so a late close cannot evict the replacement that took over.
        registry.unregister({ userId: apiKey.user_id, socket });
      });
    } catch (error) {
      // Includes the TypeError `registry.register` throws on a non-integer
      // user_id. Not swallowed and not worked around: a key row whose user_id is
      // neither an integer nor null is a corrupt identity, and the only safe
      // answer is to refuse the connection rather than bind it to a guessed key.
      console.error("browser-companion agent socket error", error);
      try {
        socket.close(WS_CLOSE_INTERNAL_ERROR);
      } catch {
        // Already closed — ws does not throw here, but a non-ws transport might.
      }
    }
  });
}

module.exports = { browserExtensionEndpoints };
