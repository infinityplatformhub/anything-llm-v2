/**
 * The dispatcher: the one place a command from the server becomes an action in
 * the browser, and therefore the one place the allowlist is enforced.
 *
 * WHY THE GATE IS THE PATH, NOT A STEP
 *
 * `allowlist.js` explains why `isAllowed` is the entire security boundary: the
 * manifest holds `<all_urls>` and `debugger`, Chrome has already granted every
 * site the user is logged into, and CDP input is indistinguishable from the
 * user's own hands. Chrome re-checks nothing after that grant. So a perfect
 * `isAllowed` is worth exactly nothing unless it is CALLED, every time.
 *
 * The obvious shape for this file — a `switch` where each `case` remembers to
 * call the gate first — fails the first time a twelfth tool is added by someone
 * who copies the wrong case. So the gate is not something a case does. It is
 * something `handle` does to every command before any case runs:
 *
 *   1. A command exists only as an entry in COMMANDS. An unlisted verb reaches
 *      no code at all.
 *   2. Every entry MUST name a `gate` from the closed GATE_RESOLVERS set.
 *      `assertCommandTable` runs at module load and throws if one does not, so
 *      an ungated command cannot be imported, let alone dispatched — the
 *      extension fails to load and the test file fails to import.
 *   3. There is deliberately NO `gate: "none"`. There is no opt-out to reach
 *      for, so a new command's author has to choose which url is judged, not
 *      whether one is.
 *   4. A resolver that yields no url is a DENIAL, not a pass. Without that, a
 *      resolver returning `[]` — page_switch matching no tab, an accessor
 *      handing back undefined — would sail through `Array.prototype.every`
 *      vacuously, which is the quietest possible bypass.
 *   5. `run` never receives the allowlist and never receives a tab id it could
 *      have obtained before the gate: `handle` resolves the tab and attaches
 *      the debugger only after every url has passed.
 *
 * `__tests__/dispatch.test.js` enumerates COMMANDS from this module and asserts
 * every listed command denies against an empty allowlist. A twelfth tool that
 * skips the gate turns that red without anyone remembering to add a case.
 *
 * EVERYTHING ON THE FRAME IS UNTRUSTED, INCLUDING FIELDS NOBODY DECLARED
 *
 * The server-side plugin records that its JSON schema is ADVISORY — aibitat
 * validates nothing, so a model (or a compromised server) can put `headers`,
 * `body`, `credentials` or `method` on the wire beside `url`. Every handler
 * below reads named fields only and passes no object through, so an undeclared
 * field has nowhere to land. `cdp.fetchInPage` builds its own request for the
 * same reason.
 */
import { isAllowed, isSameOrigin, loadAllowlist } from "./allowlist.js";
import { record } from "./auditLog.js";
import { cdp as realCdp } from "./cdp.js";
import * as realPageState from "./pageState.js";

/**
 * A failure the agent should read and act on, rather than a bug.
 *
 * Separated from an ordinary throw so `handle` can record it as `error` with
 * the message intact: the agent reasons over these strings, so "call page_state
 * again" has to survive to the transcript.
 */
class CommandError extends Error {}

/* ------------------------------------------------------------------------- */
/* Argument reading — every value below arrived over a socket                 */
/* ------------------------------------------------------------------------- */

// How much of an untrusted string may appear in an audit `detail` or an error
// message this module builds. Task 6's auditLog caps its own fields as of
// commit 12519095, so this is the SECOND bound, not the only one — and it is
// deliberate: this module is the trust boundary where socket data enters, and a
// bound applied here also covers the error STRING returned to the agent, which
// the audit log's cap does not reach. A 5MB url would otherwise be interpolated
// into a 5MB refusal message and sent back over the wire.
//
// Long enough that a real url survives intact (task 6 uses 2048 for urls);
// short enough that no single field can crowd out a log or a transcript.
const MAX_ECHOED_CHARS = 2048;

/**
 * Render an untrusted value for a message or a log, bounded.
 *
 * @param {unknown} value anything off the wire
 * @returns {string}
 */
function echo(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_ECHOED_CHARS
    ? `${text.slice(0, MAX_ECHOED_CHARS)}…[truncated]`
    : text;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0)
    throw new CommandError(`"${field}" must be a non-empty string.`);
  return value;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value))
    throw new CommandError(`"${field}" must be one of: ${allowed.join(", ")}.`);
  return value;
}

/* ------------------------------------------------------------------------- */
/* Gate resolvers — which url(s) the allowlist must judge for a command       */
/* ------------------------------------------------------------------------- */

/**
 * The closed set of ways a command may name the page it acts on.
 *
 * A resolver's only job is to say WHICH urls are at stake; it never decides
 * whether they are permitted. That decision lives in `handle`, once, for all of
 * them. Each returns `{urls, target}` — `target` is opaque data `run` needs and
 * that was resolved as part of naming the url, so `run` cannot re-resolve it to
 * something the gate never saw.
 *
 * @type {Readonly<Record<string, (ctx: {command: object, deps: object, currentUrl: () => Promise<string|null>}) => Promise<{urls: unknown[], target?: any}>>}
 */
const GATE_RESOLVERS = Object.freeze({
  /** The page the agent's tab is already on. */
  async currentPage({ currentUrl }) {
    return { urls: [await currentUrl()] };
  },

  /**
   * Where the command is going, not where it is. page_navigate is judged on its
   * destination: judging the current page instead would let a compromised
   * server walk the agent anywhere as long as it started somewhere allowed.
   */
  async targetUrl({ command }) {
    return { urls: [requireString(command.url, "url")] };
  },

  /**
   * page_fetch: both. The tab's own page, because the fetch runs inside it with
   * the user's cookies, and the target, because that is what gets read. Either
   * one alone is a hole — an allowed page fetching a forbidden origin, or a
   * forbidden page fetching an allowed one and reading the response.
   */
  async currentAndTargetUrl({ command, currentUrl }) {
    return {
      urls: [await currentUrl(), requireString(command.url, "url")],
    };
  },

  /**
   * page_switch names a tab by url substring, so the url that must be judged is
   * the matched tab's real url — resolved here, handed to `run` as `target`, so
   * the tab that gets switched to is the tab that was gated.
   *
   * A substring matching nothing yields no url, which `handle` treats as a
   * denial. Matching a FORBIDDEN tab must produce a denial the caller cannot
   * tell apart from that one — otherwise page_switch is the enumeration oracle
   * `page_tabs` filtering exists to close, and a worse one: the ordinary
   * denial message quotes the offending url, so probing substrings recovers
   * the full url (path and query included) of every tab the user has open,
   * plus which guesses hit. The single character "a" was enough.
   *
   * An earlier version of this comment asserted the two cases already were the
   * same outcome. They were not — the shared denial path below quoted the url.
   * The indistinguishability is now enforced by `opaqueDenial` on the command
   * spec, and by a test comparing the two error STRINGS rather than just their
   * `ok` flags, which is what let the gap hide.
   *
   * IDENTICAL REPLIES ARE NOT ENOUGH: THE SEARCH ITSELF IS THE CHANNEL.
   *
   * Making both denials byte-identical closed the message leak and left a
   * second one underneath, because the CHOICE between success and denial still
   * depended on the secret. `find` takes the FIRST match, so with forbidden
   * tabs in the collection the ok flag answers "does a forbidden tab containing
   * <needle> sit earlier in tab order than mine?" — and the agent can arrange
   * the comparison, since `page_navigate` is gated on the destination HOST
   * while the path and query are attacker-chosen. Park a needle in your own
   * allowlisted url, switch on it, read the flag. A review amplified that
   * character by character using only permitted calls and recovered a
   * forbidden tab's full path and query in ~1,200 round trips, every one of
   * which looks like an ordinary denial in the audit log.
   *
   * So the fix is not a better message. Forbidden tabs are removed BEFORE the
   * search, so they cannot influence which tab is found, in what order, or
   * whether one is found at all. `page_switch` now searches exactly the set
   * `page_tabs` would show — the two commands finally have the same view of
   * the world — and the reply stops varying with what the user has open.
   *
   * The remaining gate check below is deliberately NOT redundant: this
   * narrowing is a resolver deciding what to search, and the decision about
   * whether a url may be acted on stays in one place, for every command.
   */
  async matchedTab({ command, deps, allowlist }) {
    const needle = requireString(command.url, "url");
    const tabs = (await deps.listAgentTabs()) ?? [];
    // Filtered first, then searched. Order is the entire point.
    const visible = tabs.filter((tab) => isAllowed(tab?.url, allowlist));
    const match = visible.find((tab) => tab.url.includes(needle));
    return { urls: match ? [match.url] : [], target: match };
  },
});

const GATE_KINDS = Object.freeze(Object.keys(GATE_RESOLVERS));

/**
 * Gates whose subject is DISCOVERED by searching the user's browser, rather
 * than named outright by the command.
 *
 * A command on one of these can be asked a question about tabs it may not see,
 * and every observable difference in the answer — the message, the ok flag,
 * which tab was chosen — is a bit about the user's browsing. `assertCommandTable`
 * therefore requires such a command to declare an `opaqueDenial`, at load.
 *
 * Kept beside `GATE_RESOLVERS` on purpose: adding a resolver that searches
 * anything means adding its name here, and the two sit in the same screen so
 * the omission is visible rather than remembered.
 */
const SEARCH_SHAPED_GATES = new Set(["matchedTab"]);

/* ------------------------------------------------------------------------- */
/* The command table                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Every verb the extension answers, and how each is gated.
 *
 * `cmd` values are the wire verbs from
 * `server/utils/agents/aibitat/plugins/browser-companion.js`; the tool names the
 * model sees are `page_*`.
 *
 * Fields:
 *   gate           — required, a key of GATE_RESOLVERS. No default and no
 *                    opt-out: see the header.
 *   sameOrigin     — also require the target url to share an origin with the
 *                    tab's current page. Declared here rather than checked
 *                    inside `run`, so it is applied by `handle` on the same
 *                    unconditional path as the gate.
 *   attach         — whether the command needs a CDP debugger attachment.
 *                    False for the tab-management verbs, so they do not raise
 *                    the "is debugging this browser" infobar for nothing.
 *   invalidatesMap — whether the command can move the page under the element
 *                    map. Applied by `handle`, because "remember to invalidate"
 *                    is exactly the kind of step a new case forgets, and the
 *                    cost of forgetting is a click on the wrong element.
 *   opaqueDenial   — the command's gate subject is discovered by SEARCHING the
 *                    user's tabs, so a denial must not say what was found. When
 *                    set, every gate refusal for this command returns this one
 *                    string and nothing derived from the url, making "matched a
 *                    forbidden tab" and "matched nothing" indistinguishable.
 *                    The real url still goes to the audit log, which is local
 *                    and is the user's own record. A property of the command
 *                    rather than a branch in the denial path, so a future
 *                    search-shaped command declares it instead of rediscovering
 *                    the oracle.
 *   run            — the action, reached only after the gate has passed.
 */
const COMMAND_TABLE = Object.freeze({
  state: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: false,
    async run({ tabId, deps }) {
      return { data: await deps.pageState.capture(tabId) };
    },
  },

  read: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: false,
    async run({ tabId, deps }) {
      return { data: await deps.pageState.read(tabId) };
    },
  },

  click: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: true,
    async run({ tabId, command, deps }) {
      const point = await resolvePoint(tabId, command.id, deps);
      await deps.cdp.click(tabId, point.x, point.y);
      return { data: { clicked: command.id }, detail: `id ${command.id}` };
    },
  },

  type: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: true,
    async run({ tabId, command, deps }) {
      const text = requireString(command.text, "text");
      const point = await resolvePoint(tabId, command.id, deps);
      // The click focuses the field first. Typing into an unfocused page sends
      // the text to whatever the site last focused, which is nothing useful.
      await deps.cdp.click(tabId, point.x, point.y);
      await deps.cdp.type(tabId, text);
      // The text itself is deliberately NOT recorded: the audit log is stored
      // unencrypted in extension storage, and this field carries whatever the
      // agent was asked to type, including a password it was handed.
      return {
        data: { typed: command.id },
        detail: `id ${command.id}, ${text.length} chars`,
      };
    },
  },

  key: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: true,
    async run({ tabId, command, deps }) {
      const name = requireString(command.key, "key");
      await deps.cdp.key(tabId, name);
      return { data: { pressed: name }, detail: name };
    },
  },

  scroll: {
    gate: "currentPage",
    attach: true,
    invalidatesMap: true,
    async run({ tabId, command, deps }) {
      const direction = requireOneOf(
        command.direction,
        ["up", "down"],
        "direction"
      );
      await deps.cdp.scroll(tabId, direction);
      return { data: { scrolled: direction }, detail: direction };
    },
  },

  navigate: {
    gate: "targetUrl",
    // No CDP attachment: `chrome.tabs.update` does the navigation, and this is
    // also the one command that works before any tab exists — the bootstrap
    // path out of a tab sitting on a page the allowlist refuses.
    attach: false,
    invalidatesMap: true,
    async run({ tabId, command, deps }) {
      await deps.cdp.navigate(tabId, command.url);
      return { data: { url: command.url } };
    },
  },

  fetch: {
    gate: "currentAndTargetUrl",
    sameOrigin: true,
    attach: true,
    invalidatesMap: false,
    async run({ tabId, command, deps }) {
      const body = await deps.cdp.fetch(tabId, command.url);
      return { data: body };
    },
  },

  tabs: {
    // Gated on the current page like every other read. A tab list is page data:
    // the urls the user has open are exactly what a compromised server would
    // most like to enumerate. The result is filtered again below — being
    // allowed to ask is not being allowed to see everything.
    gate: "currentPage",
    attach: false,
    invalidatesMap: false,
    async run({ deps, allowlist }) {
      const tabs = (await deps.listAgentTabs()) ?? [];
      const visible = tabs.filter((tab) => isAllowed(tab?.url, allowlist));
      const withheld = tabs.length - visible.length;
      return {
        data: {
          tabs: visible.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title ?? "",
          })),
          // Named rather than hidden: an agent that cannot see a tab should be
          // told one exists, or it will conclude the user has none and act on
          // that. The url is what is withheld, not the fact.
          withheld,
        },
        detail: `${visible.length} shown, ${withheld} withheld`,
      };
    },
  },

  switch: {
    gate: "matchedTab",
    // The subject is found by searching the user's open tabs, so a denial must
    // reveal nothing about what the search found. See `matchedTab`.
    opaqueDenial:
      "denied: no tab you may act on matched that text. page_tabs lists the tabs available to you.",
    attach: false,
    invalidatesMap: true,
    async run({ target, deps }) {
      // `target` came from the resolver, so the tab switched to is the tab whose
      // url the gate judged. Re-finding it here would reintroduce the gap.
      await deps.switchToTab(target.id);
      return { data: { url: target.url }, detail: target.url };
    },
  },

  close: {
    // CONTRACT: page_close closes the agent's own CURRENT tab — the one every
    // other command acts on — and nothing else. Task 6 left this ungated
    // because it carries no url argument; that was the hole. Closing a page is
    // acting on it: it can dismiss a beforeunload guard and lose work the user
    // had in progress, and an ungated "close the active tab" is a way to reach
    // a page the allowlist refuses. So it is gated on that tab's url like any
    // other command. If the tab is somewhere not allowed, the recovery is
    // page_navigate (gated on its destination) and then close.
    gate: "currentPage",
    attach: false,
    invalidatesMap: true,
    async run({ tabId, deps }) {
      // Detach first. `chrome.debugger` has no obligation to tell us about the
      // tab we just closed before the next command tries to reuse the id.
      await deps.cdp.detach(tabId);
      await deps.closeTab(tabId);
      return { data: { closed: tabId } };
    },
  },
});

/**
 * Fail the module load if any command is not gated.
 *
 * At load, not in a test: a test can be deleted, and a gate that only a test
 * enforces is a gate that a rushed branch removes. This throws in the service
 * worker and in every test file that imports this module.
 *
 * `COMMANDS` is bound to this function's RETURN value, not merely checked by it
 * afterwards, so deleting the call does not leave a working dispatcher with the
 * check gone — it leaves no command table at all, and everything fails loudly.
 * A mutation that removed a free-standing `assertCommandTable(COMMANDS)` line
 * survived the suite; this shape has nowhere for that mutation to live.
 */
function assertCommandTable(table) {
  for (const [cmd, spec] of Object.entries(table)) {
    if (!GATE_KINDS.includes(spec.gate)) {
      throw new Error(
        `dispatch: command "${cmd}" declares gate "${spec.gate}", which is not one of ${GATE_KINDS.join(", ")}. Every command must name the url the allowlist judges — there is no ungated command.`
      );
    }
    if (typeof spec.run !== "function")
      throw new Error(`dispatch: command "${cmd}" has no run().`);

    // A search-shaped gate discovers its subject by looking through the user's
    // tabs, so its denial must say nothing about what was found. `opaqueDenial`
    // was previously honoured-if-present (`spec.opaqueDenial ?? …`), which made
    // it exactly the silent opt-out this module refuses to offer for `gate`: a
    // review added a second `matchedTab` command without it, the two failing
    // tests both said "add an ARGS fixture" and neither mentioned the field, so
    // adding the fixture — the obvious next step — produced a green suite with
    // the oracle fully reopened at runtime.
    //
    // Required at LOAD for the same reason `gate` is: a rule only a test
    // enforces is a rule a rushed branch removes, and the failure has to name
    // the thing that is missing.
    if (SEARCH_SHAPED_GATES.has(spec.gate) && !spec.opaqueDenial) {
      throw new Error(
        `dispatch: command "${cmd}" uses the search-shaped gate "${spec.gate}" but declares no opaqueDenial. A command that finds its subject by searching the user's tabs must deny with a constant that reveals nothing about what was found — otherwise its denial is an enumeration oracle for the tabs the user has open.`
      );
    }
    if (spec.opaqueDenial !== undefined && typeof spec.opaqueDenial !== "string")
      throw new Error(
        `dispatch: command "${cmd}" declares a non-string opaqueDenial.`
      );
  }
  return table;
}

/**
 * The table `handle` dispatches on. Every command in it has been proved to name
 * a gate before this binding exists.
 */
const COMMANDS = assertCommandTable(COMMAND_TABLE);

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* ------------------------------------------------------------------------- */

async function resolvePoint(tabId, id, deps) {
  const point = await deps.lookup(tabId, id);
  if (!point) {
    throw new CommandError(
      `No element [${id}] on this page. Call page_state again — the page has changed since the map you are using was made.`
    );
  }
  return point;
}

function reply(requestId, patch) {
  return { requestId, ...patch };
}

/**
 * Write one audit entry without letting a failed write escape.
 *
 * `handle`'s contract is that it NEVER rejects, because it runs inside the
 * socket's message handler where a throw takes the connection down for every
 * command in flight. `auditLog.record` rejects on a storage failure (a full
 * store — which `auditLog.js` documents as an expected hostile-server outcome,
 * not a theoretical one), and every `record` call here is either outside the
 * try or inside the catch. So an unwrapped call breaks the contract on all four
 * paths, and the worst shape is a click that already happened: the action is
 * done, the write failed, and the rejection kills the socket.
 *
 * Still awaited, not fire-and-forget: the entry must be durable before the
 * agent is told the command succeeded, or a failure the agent papers over
 * leaves no trace in the log the user reads.
 *
 * The failure is NOT swallowed silently — that would be the "blinded audit log"
 * this module cares about. Task 6 keeps a sticky `getWriteFailure()` flag for
 * the popup to surface, `console.warn` puts it in the service worker log, and
 * the caller learns of it through the returned boolean so the agent's reply can
 * say so too.
 *
 * @returns {Promise<boolean>} true when the entry was written
 */
async function safeRecord(d, entry) {
  try {
    await d.record(entry);
    return true;
  } catch (error) {
    console.warn(
      `browser-companion: the audit log write for "${entry?.cmd}" failed, so this command is NOT in the log. The extension popup reports the failure. Reason: ${String(
        error?.message ?? error
      )}`
    );
    return false;
  }
}

// Appended to a successful reply whose audit entry could not be written. The
// agent reads its replies, so "this happened but is unrecorded" has to be
// something it can say back to the user — a bare success would be a quieter
// lie than the one HIGH 2 fixed.
const UNRECORDED_NOTICE =
  " (warning: this action could not be written to the extension's audit log, which may be full — tell the user, and check the extension popup.)";

/**
 * Fill in the real implementations for anything the caller did not inject.
 *
 * Deliberately does NOT default the tab accessors (`agentTabUrl`,
 * `ensureAgentTab`, `listAgentTabs`, `switchToTab`, `closeTab`). Task 8 owns
 * the tab manager, and a no-op or guessed default here would make a wiring
 * mistake look like a working dispatch — the failure would surface as "the
 * agent did nothing" rather than as a missing dependency.
 */
function withDefaults(deps = {}) {
  return {
    loadAllowlist,
    record,
    lookup: realPageState.lookup,
    ...deps,
    // Merged rather than replaced so a test may override one method without
    // restating the rest. A method neither injected nor real does not exist and
    // throws, which is the loud outcome; a silent no-op default would be the
    // quiet one.
    cdp: { ...realCdp, ...(deps.cdp ?? {}) },
    pageState: { ...realPageState, ...(deps.pageState ?? {}) },
  };
}

/**
 * Run one command from the server.
 *
 * Never throws and never rejects: this is called from the socket message
 * handler, where a throw takes the connection down for every command in flight.
 * Every path resolves `{requestId, ok, data|error}`.
 *
 * @param {{requestId?: string, cmd?: string, [k: string]: unknown}} command the
 *   frame as it arrived — untrusted, undeclared fields included
 * @param {object} [deps] injected for tests; real implementations otherwise
 * @returns {Promise<{requestId: any, ok: boolean, data?: any, error?: string}>}
 */
export async function handle(command, deps) {
  const requestId = command?.requestId;
  const cmd = command?.cmd;
  const d = withDefaults(deps);

  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, cmd)
    ? COMMANDS[cmd]
    : null;
  if (!spec) {
    // `hasOwnProperty`, not `COMMANDS[cmd]` alone: a cmd of "constructor" or
    // "toString" would otherwise find a function on Object.prototype and be
    // treated as a command. Recorded, because a run of unknown verbs is what a
    // compromised or mismatched server looks like from here.
    await safeRecord(d, {
      // Bounded: `cmd` is server-controlled and is recorded on this path
      // BEFORE any check has passed, so an unbounded one is a way to write
      // arbitrarily large entries into the audit log without being allowlisted
      // for anything.
      cmd: echo(cmd),
      url: null,
      outcome: "denied",
      detail: "unknown command",
    });
    return reply(requestId, {
      ok: false,
      error: `Unknown browser command "${echo(cmd)}".`,
    });
  }

  // Memoised: several resolvers ask for it, and `navigate` must never ask —
  // it is the only command that works with no usable tab, and calling the
  // accessor eagerly would break that bootstrap.
  let currentUrlPromise = null;
  const currentUrl = () => {
    if (!currentUrlPromise) currentUrlPromise = Promise.resolve(d.agentTabUrl());
    return currentUrlPromise;
  };

  try {
    // ---- THE GATE. Unconditional, before any tab is resolved or attached. ---
    const allowlist = await d.loadAllowlist();
    // `allowlist` is passed to the resolver, but ONLY so a search-shaped
    // resolver can narrow what it searches — never so a resolver can decide
    // whether a url is permitted. That judgement stays below, in one place, for
    // every command. See `matchedTab`, which is the whole reason this argument
    // exists: a resolver that searches the user's tabs must not have forbidden
    // tabs in the collection it searches, or the CHOICE it makes leaks them
    // even when every reply is identical.
    const { urls, target } = await GATE_RESOLVERS[spec.gate]({
      command,
      deps: d,
      currentUrl,
      allowlist,
    });

    // An empty list is a denial, never a vacuous pass. See the header, point 4.
    //
    // BOTH HALVES ARE LOAD-BEARING. The `Array.isArray` half is not a stylistic
    // guard on the `length` check: remove it and any length-bearing non-array
    // that yields nothing when iterated — `{length: 1}`, a Set, a bare string
    // of length 0 — passes straight through the `for…of` below WITHOUT A SINGLE
    // isAllowed CALL, and reaches ensureAgentTab, attach and click. That is a
    // full bypass, not a degraded message.
    //
    // A mutation deleting it survives the suite today, because no resolver can
    // currently produce such a shape — the survival is a fact about the current
    // resolvers, NOT about this line being redundant. An earlier version of this
    // comment called the guard defensive, which is the reading that gets a guard
    // deleted; a resolver-contract test covers the reachable half.
    if (!Array.isArray(urls) || urls.length === 0) {
      await safeRecord(d, {
        cmd,
        url: null,
        outcome: "denied",
        detail: "no page to act on",
      });
      return reply(requestId, {
        ok: false,
        error:
          spec.opaqueDenial ??
          `denied: there is no page for "${cmd}" to act on. The agent's tab may be closed, or no open tab matched.`,
      });
    }

    for (const url of urls) {
      if (isAllowed(url, allowlist)) continue;
      await safeRecord(d, {
        cmd,
        // Recorded as given but bounded, and null for a non-string: the audit
        // log is where the user finds out what a misbehaving server tried, so
        // the value is kept — just never at a size that can crowd out the
        // history around it.
        url: typeof url === "string" ? echo(url) : null,
        outcome: "denied",
        detail: `not in allowlist: ${echo(url)}`,
      });
      return reply(requestId, {
        ok: false,
        // The audit record above keeps the real url; the REPLY does not, for a
        // command whose subject was discovered by searching the user's tabs.
        // Byte-identical to the no-match denial by construction — both read
        // `spec.opaqueDenial` — rather than by two strings someone keeps in
        // step by hand.
        error:
          spec.opaqueDenial ??
          `denied: ${echo(url)} is not in the allowlist the user set in the extension. Ask the user to add the domain there if this page should be reachable.`,
      });
    }

    if (spec.sameOrigin && !isSameOrigin(command.url, await currentUrl())) {
      await safeRecord(d, {
        cmd,
        url: typeof command.url === "string" ? echo(command.url) : null,
        outcome: "denied",
        detail: "cross-origin",
      });
      return reply(requestId, {
        ok: false,
        error: `denied: page_fetch must be same-origin as the tab it runs in (${echo(
          await currentUrl()
        )}). Use page_navigate first, then fetch.`,
      });
    }
    // ---- END OF THE GATE. Nothing below runs for a url that did not pass. ---

    const tabId = await d.ensureAgentTab();
    if (spec.attach) await d.cdp.attach(tabId);

    const { data = null, detail = null } = await spec.run({
      tabId,
      command,
      deps: d,
      allowlist,
      target,
    });

    // Applied here, not in `run`. A command that moves the page and forgets to
    // drop the map leaves ids pointing at elements that have moved, and the
    // next click lands on whatever slid into those coordinates.
    if (spec.invalidatesMap) d.pageState.invalidate(tabId);

    // The action has already happened by this point, so a failed audit write
    // must not turn it into a failure the agent might retry — a retried click
    // is a second click. It stays a success, carrying a notice the agent can
    // pass to the user, rather than a silent one.
    const recorded = await safeRecord(d, {
      cmd,
      url: urls[0],
      outcome: "ok",
      detail,
    });
    return reply(requestId, {
      ok: true,
      data,
      ...(recorded ? {} : { warning: UNRECORDED_NOTICE.trim() }),
    });
  } catch (error) {
    // Bounded like every other echoed value: an error message can carry
    // page-derived or server-derived text (a CDP failure quotes the url, a
    // page exception quotes its own throw), so it is untrusted by origin even
    // though it arrives as an exception.
    const detail = echo(error?.message ?? error);
    // Recorded before the reply, so a failure the agent papers over is still in
    // the log the user reads.
    await safeRecord(d, { cmd: echo(cmd), url: null, outcome: "error", detail });
    return reply(requestId, { ok: false, error: detail });
  }
}

export {
  COMMANDS,
  GATE_RESOLVERS,
  GATE_KINDS,
  SEARCH_SHAPED_GATES,
  CommandError,
  assertCommandTable,
  // Exported for one assertion: that dependency defaulting never INVENTS a
  // method. A `cdp` or `pageState` built with a fallback for unknown keys would
  // turn a typo in a future command into a silent no-op — the command reports
  // success and the browser does nothing.
  withDefaults,
};
