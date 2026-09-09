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

// ws readyState for OPEN. Named for the same reason protocol.js names it: the
// bare `1` reads as a magic number at the one place a dead socket is detected.
const WS_OPEN = 1;

// ws refuses a close reason over 123 bytes with a throw ("The message must not be
// greater than 123 bytes"), verified against ws@7.5.10. Kept well under.
const EVICTED_REASON = "Replaced by a newer connection.";

// Subprotocol marker the extension offers first, with the key as the second
// value: `new WebSocket(url, [BROWSER_COMPANION_SUBPROTOCOL, "brx-..."])`.
//
// Why the key travels here rather than in the query string: the upgrade request
// is an ordinary HTTP GET, so `?key=` is written verbatim into the access log of
// every reverse proxy, ingress and CDN in front of this server — plaintext, at
// rest for weeks, on infrastructure this repo does not configure. A
// `Sec-WebSocket-Protocol` header is not logged by any of those defaults.
//
// `ws@7.5.10` selects the FIRST offered subprotocol and echoes only that one back
// in the handshake response — verified against the real library — so the marker
// is what appears on the wire and the key is never echoed. The browser
// `WebSocket` constructor rejects the connection if the server answers with a
// value it did not offer, which is why the marker must be offered first and
// echoed unchanged.
const BROWSER_COMPANION_SUBPROTOCOL = "anythingllm-browser-companion";

// Matches a `brx-` API key anywhere in a string. `BrowserExtensionApiKey.makeSecret`
// builds them as `brx-` + a uuid-apikey value (upper-case base32 with dashes), so
// the character class covers the whole token and stops at the first character
// that cannot be part of one.
const API_KEY_PATTERN = /brx-[A-Za-z0-9-]+/g;

/**
 * Strip any API key out of text bound for a log.
 *
 * Prisma embeds a failing query's arguments in its error message, so an error
 * raised while validating a key carries that key in plaintext. Redacting the
 * token is the only thing that works: truncating the message does not, because
 * in the real error shape the key appears well inside the first 200 characters.
 *
 * @param {string} text
 * @returns {string}
 */
function redactApiKeys(text) {
  return text.replace(API_KEY_PATTERN, "brx-[redacted]");
}

/**
 * Pull the API key off a WebSocket upgrade request.
 *
 * Two accepted sources, in order of preference:
 *   1. `Sec-WebSocket-Protocol: anythingllm-browser-companion, brx-...`
 *   2. `?key=brx-...` — DEPRECATED, retained so an already-installed extension
 *      keeps working across the upgrade.
 *
 * The query path may be deleted once (a) the task-8 extension offers the
 * subprotocol, and (b) every installed extension has updated past that release.
 * Until both hold, removing it silently breaks connected users. Whoever writes
 * the task-8 client should read this comment before choosing a transport.
 *
 * @param {object} request the upgrade request
 * @returns {{key: string|null, source: "subprotocol"|"query"|null}}
 */
function browserCompanionKeyFrom(request) {
  // Express lower-cases header names; the value is the raw comma-separated list
  // the client offered, e.g. "anythingllm-browser-companion, brx-abc".
  const offered = request?.headers?.["sec-websocket-protocol"];
  if (typeof offered === "string") {
    const tokens = offered
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    // Anything after the marker is the key. Indexed rather than "last token" so
    // a client offering extra subprotocols after the key cannot shift which
    // value is treated as the credential.
    if (tokens[0] === BROWSER_COMPANION_SUBPROTOCOL && tokens.length > 1)
      return { key: tokens[1], source: "subprotocol" };
  }

  // `String(key)` is deliberately NOT used: a missing key would become the
  // literal "undefined" and a repeated ?key=a&key=b (express parses that to an
  // array) would become "a,b" — both reach the DB as a lookup that merely
  // misses, and neither should get that far.
  const fromQuery = request?.query?.key;
  if (typeof fromQuery === "string" && fromQuery)
    return { key: fromQuery, source: "query" };

  return { key: null, source: null };
}

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
  // user's own Chrome. A browser WebSocket cannot set headers, so the key travels
  // in the subprotocol list (preferred) or the query string (deprecated) — see
  // `browserCompanionKeyFrom`. It is the same key /browser-extension/check
  // accepts as a bearer.
  //
  // This handler is the authentication boundary for the whole feature: everything
  // behind it (the registry entry, every command the protocol writes to this
  // socket) trusts that whoever holds this socket is the user identified here.
  // The only identity that may reach `registry.register` is `apiKey.user_id` from
  // the validated `browser_extension_api_keys` row — never anything off the
  // request, which is attacker-controlled.
  app.ws("/browser-companion/agent-socket", async function (socket, request) {
    try {
      const { key, source } = browserCompanionKeyFrom(request);
      if (!key) return socket.close(WS_CLOSE_UNAUTHORIZED);

      // A deprecated path nobody can see being used is a path that never gets
      // removed. Logged once per connection, not per command, and only for the
      // fallback — the supported transport stays silent.
      if (source === "query")
        console.warn(
          `browser-companion: extension authenticated with the deprecated ?key= query parameter. The key is written to upstream proxy access logs this way; the extension should offer it as the "${BROWSER_COMPANION_SUBPROTOCOL}" subprotocol instead.`
        );

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
        // Truthy, NOT `=== true`: `schema.prisma` declares `suspended Int
        // @default(0)` and `User.get` does not cast it, so a suspended user
        // arrives here as `1`, never `true`. Tightening this to `=== true` — the
        // most natural-looking edit, and what a TypeScript migration would
        // produce — turns it into an auth bypass that lets a suspended user's
        // extension register and be driven. Pinned by a test using `1`/`0`.
        if (!user || user.suspended) return socket.close(WS_CLOSE_FORBIDDEN);
      }
      // Single-user mode intentionally has no user check: `validate` returns any
      // `brx-` row regardless of user_id, and every such connection registers
      // under the same null sentinel. So it is one browser per INSTANCE, not per
      // key — a second extension evicts the first with 4409. Correct as designed
      // (single-user mode has one human, so per-instance and per-user are the
      // same statement), but surprising if you assumed keys were per-device.

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

      // Defensive assertion on the register/attach identity invariant.
      //
      // BE CLEAR ABOUT WHAT THIS IS: today this branch is UNREACHABLE, not
      // merely rare. `registry.register` stores the object it is given and
      // `resolve` returns exactly that object or null, so a non-null resolve
      // that differs from `socket` cannot be produced — verified against the
      // real registry across every connection shape that reaches this line. The
      // one shape where `resolve` does return null (a null user_id in
      // multi-user mode) is already closed 4403 above. Replacing the condition
      // with `if (false)` changes no observable behaviour.
      //
      // It is kept anyway, and only for this: protocol.js keys its pending map
      // on the socket OBJECT, so if a future edit ever puts a wrapper, proxy,
      // spread copy or prototype alias between `register` and `attach`, every
      // reply silently stops matching and every command times out with text
      // identical to a disconnected browser. This turns that into a refused
      // connection with a named cause instead. It is an assertion against a
      // future change, not a runtime defence against anything reachable now.
      //
      // What it does NOT cover, and never did: a socket swapped after connect,
      // and an adversarial cross-socket echo. Both are reply-path events, and
      // both are handled by the mismatch warning in `protocol.handleMessage`.
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
        // Answer the commands already on the wire. Without this they wait out
        // their own timeout and report "timed out after 20000ms", which reads as
        // a slow page rather than a closed browser. Scoped to this socket, so one
        // extension disconnecting cannot settle another user's commands.
        protocol.drainSocket(socket);
      });

      // M-5: the client may have died during the awaits above. The close event
      // has already fired by now, so the listener just attached will never run,
      // and the entry registered a moment ago would be a dead socket that an
      // agent run can still resolve — and, worse, one that evicts a live
      // extension that took the slot while this connection was authenticating.
      // Checked after the listener is attached so the two cannot both miss.
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN) {
        registry.unregister({ userId: apiKey.user_id, socket });
        protocol.drainSocket(socket);
      }
    } catch (error) {
      // Includes the TypeError `registry.register` throws on a non-integer
      // user_id. Not swallowed and not worked around: a key row whose user_id is
      // neither an integer nor null is a corrupt identity, and the only safe
      // answer is to refuse the connection rather than bind it to a guessed key.
      // Redacted, and the message only — never the error object. A Prisma
      // failure embeds the failing query's arguments, which on this path is the
      // raw `brx-` key: a live, long-lived credential in plaintext server logs.
      //
      // Truncation alone does NOT fix this and was measured before being
      // rejected: in the real Prisma error shape the key sits at index 81-135,
      // so a 200-char slice still contains it. Only removing the token works.
      console.error(
        "browser-companion agent socket error:",
        redactApiKeys(String(error?.message ?? error))
      );
      try {
        socket.close(WS_CLOSE_INTERNAL_ERROR);
      } catch {
        // Already closed — ws does not throw here, but a non-ws transport might.
      }
    }
  });
}

module.exports = { browserExtensionEndpoints };
