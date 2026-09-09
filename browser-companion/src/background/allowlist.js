/**
 * The extension-side allowlist gate.
 *
 * WHY THIS CODE IS THE WHOLE SECURITY BOUNDARY
 *
 * The manifest asks for `<all_urls>` plus `debugger`, so Chrome has already
 * granted this extension every site the user is logged into and the ability to
 * send input those sites cannot tell apart from the user's own. Chrome will not
 * re-check anything after that grant. `isAllowed` is therefore not a
 * convenience filter over an already-safe capability -- it IS the capability's
 * only limit, and the README promises the user exactly that. Every branch below
 * fails closed for that reason: an input this module does not fully understand
 * is denied, never waved through.
 *
 * It also has to hold against a hostile server: the socket peer is remote and
 * can be compromised, so a URL arriving over the wire is untrusted input rather
 * than a parameter.
 */

const STORAGE_KEY = "companionAllowlist";

// chrome.debugger attaches only to http(s) pages, and every other scheme is a
// way out of the web that the host rules below cannot reason about at all --
// `file:` reaches the disk, `chrome:` reaches the browser's own settings, and
// `javascript:`/`data:` carry their payload in place of a host. Refused before
// host matching rather than after, so no host rule can ever admit one.
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Reduce a host to the single form both sides of a comparison are measured in.
 *
 * The same name can be written several ways: `LinkedIn.com`, `münchen.de`
 * versus its punycode `xn--mnchen-3ya.de`, or a fully-qualified `linkedin.com.`
 * with the root label spelled out. Comparing those as raw strings gets the
 * answer wrong in both directions, so the URL's host and every allowlist entry
 * are both pushed through the same WHATWG parser -- which applies IDNA/UTS-46
 * -- and the root label is dropped. Using one function on both sides is the
 * point: a homograph normalises identically for entry and URL, so `ɡoogle.com`
 * (U+0261) becomes `xn--oogle-qmc.com` and never matches an entry for
 * `google.com`.
 *
 * Both callers pass a hostname that `URL` produced for an http(s) URL, and the
 * WHATWG parser already lower-cases and IDNA-folds the host of a special
 * scheme. So there is deliberately no `toLowerCase()` here: it would be a line
 * that can never change the result, reading as a safeguard while guarding
 * nothing. The case tests cover this through the real parser instead.
 *
 * @param {string} hostname a hostname already extracted by `URL`
 * @returns {string} the comparison form; "" only for the input ".", which
 *   `parseEntry` rejects on the entry side so it matches nothing
 */
function canonicalHost(hostname) {
  // A single trailing dot is the DNS root label and denotes the same name, so
  // it is dropped. A name with more dots keeps one, which matches no entry:
  // `parseEntry` rejects any entry still ending in a dot, so a host like
  // `linkedin.com..` cannot be canonicalised into `linkedin.com`.
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * Parse one allowlist entry into a rule, or reject it.
 *
 * Entries are user-typed, so they arrive with whatever the user typed: a
 * scheme, a port, a path, a stray space, or nothing at all. A permissive
 * reading of a malformed entry is the dangerous direction -- a bare
 * `String(raw).trim()` turns the entry `"*."` into a rule matching every host,
 * and turns any non-string into the literal `"[object Object]"`. So an entry is
 * accepted only when it is exactly a hostname and nothing else, proven by
 * requiring the parsed URL to round-trip back to the bare authority it was
 * built from.
 *
 * @param {unknown} raw
 * @returns {{host: string, wildcard: boolean} | null} null when unusable
 */
function parseEntry(raw) {
  // Deliberately not coerced. A non-string in the allowlist means storage holds
  // something this code did not write, and guessing at its meaning is how an
  // object turns into a matching rule.
  if (typeof raw !== "string") return null;

  // `trim` is load-bearing -- `new URL("https:// linkedin.com ")` throws, so a
  // padded entry would be silently dropped rather than honoured. Case is NOT
  // folded here: the URL parser below lower-cases the host of a special scheme
  // itself, and a `toLowerCase()` call that can never change an outcome would
  // look like a safeguard while guarding nothing. The `*.` prefix is ASCII, so
  // the unfolded `startsWith` is exact.
  let candidate = raw.trim();
  let wildcard = false;
  if (candidate.startsWith("*.")) {
    wildcard = true;
    candidate = candidate.slice(2);
  }
  // `*` is meaningful only as the leading label handled above. Anywhere else it
  // is not a pattern this matcher implements, and a bare `*` must never become
  // "allow everything". The empty check also rejects a lone `"*."`.
  if (!candidate || candidate.includes("*")) return null;

  let parsed;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    return null;
  }

  // The round-trip is what rejects an entry carrying anything besides a host.
  // `linkedin.com:8080` keeps a port, `linkedin.com/x` a path, `a@b` userinfo,
  // and `evil.test\linkedin.com` is re-read by the URL spec as a path on
  // evil.test -- each would otherwise be silently truncated down to a host the
  // user never meant to authorise.
  if (parsed.href !== `https://${parsed.host}/`) return null;
  if (parsed.host !== parsed.hostname) return null;

  const host = canonicalHost(parsed.hostname);
  // A name that still starts or ends with a dot after canonicalisation is not a
  // hostname; `.com` and `linkedin.com..` land here.
  if (!host || host.startsWith(".") || host.endsWith(".")) return null;

  return { host, wildcard };
}

/**
 * Decide whether the agent may act on this URL. Default DENY.
 *
 * @param {unknown} url the URL to check, as it arrived
 * @param {unknown} allowlist entries; a `"*."` prefix also covers subdomains
 * @returns {boolean} true only when some entry positively admits this URL
 */
export function isAllowed(url, allowlist) {
  // A missing or empty list means nothing is allowed. That is the state a fresh
  // install is in, so it has to be the safe one.
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  if (typeof url !== "string") return false;

  let host;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false;
    // `hostname`, never `host`, `href`, or a substring of the URL. The parser
    // is what separates the real host from everything merely shaped like one:
    // the query in `evil.test/?x=linkedin.com`, and the userinfo in
    // `linkedin.com@evil.test`, which reads as a host to the eye and to any
    // string match but is not one.
    host = canonicalHost(parsed.hostname);
  } catch {
    return false;
  }
  // No empty-host guard here on purpose. http(s) are special schemes, so the
  // WHATWG parser rejects an empty host outright (`new URL("https://")` throws
  // and is caught above) -- an `if (!host) return false` line could never fire
  // in production, and an unreachable guard is false reassurance, not defence.
  // A host of "." is reachable, and is handled by matching no entry rather than
  // by a special case: `parseEntry` rejects every entry that is a bare dot.

  return allowlist.some((raw) => {
    const entry = parseEntry(raw);
    if (!entry) return false;
    if (entry.wildcard) {
      // The dot is load-bearing. A plain `endsWith(base)` would admit
      // `notlinkedin.com`, and matching the base as a substring anywhere would
      // admit `flowaccount.com.evil.test`, which is a host on evil.test.
      return host === entry.host || host.endsWith(`.${entry.host}`);
    }
    return host === entry.host;
  });
}

/**
 * Whether two URLs share an origin, for the `page_fetch` same-origin rule.
 *
 * The server enforces only that `page_fetch` is a GET; keeping the fetch on the
 * page's own origin is entirely this extension's job. The comparison is
 * `origin` (scheme + host + port) rather than host alone -- an http:// page and
 * an https:// one are different origins, and so are two ports on one host. Both
 * URLs still have to clear `isAllowed` separately; this answers only the origin
 * question.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function isSameOrigin(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    // Opaque origins serialise to the string "null" and would therefore compare
    // equal, so the schemes producing one are refused outright: without this,
    // `isSameOrigin("file:///a", "file:///b")` is true.
    //
    // Written as one guard over both operands rather than two, because `blob:`
    // makes the per-operand check load-bearing: unlike file: or data:, the
    // origin of `blob:https://linkedin.com/u` is the REAL origin
    // `https://linkedin.com` and compares equal to the page's, so a guard
    // checking one side only lets a blob URL pass as same-origin with the page.
    const schemesOk = [left, right].every((u) =>
      ALLOWED_SCHEMES.has(u.protocol)
    );
    if (!schemesOk) return false;
    return left.origin === right.origin;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<string[]>} the stored allowlist, or [] when there is none
 */
export async function loadAllowlist() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const list = stored?.[STORAGE_KEY];
  // Anything that is not an array is treated as absent, which `isAllowed` reads
  // as "allow nothing".
  return Array.isArray(list) ? list : [];
}

/**
 * Persist the allowlist, or throw.
 *
 * WHY THIS IS NOT A BARE `set`
 *
 * The storage quota covers the WHOLE extension, so a full store makes this
 * write fail while everything else still looks healthy. A bare `set` swallowed
 * nothing, but it also proved nothing: the caller could not tell a saved list
 * from a rejected one, and `isAllowed` would carry on enforcing whatever list
 * was already in storage.
 *
 * Measured, and it narrows the threat usefully: a pure REMOVAL shrinks the
 * stored JSON, so if the current list fits then the shorter one does too -- at
 * zero headroom a revocation still succeeded. The quota alone therefore cannot
 * produce "I removed it but it is still live". What remains reachable is an
 * edit that GROWS the list, and any failure that is not about size at all.
 *
 * The rule is therefore that NO storage failure may be mistaken for a saved
 * list. The write is verified by reading back what was actually stored, and any
 * failure throws. Throwing rather than returning false is deliberate: a caller
 * that forgets to check a boolean silently reintroduces the bug, whereas one
 * that forgets to catch gets a visible error. Task 9's popup must catch this
 * and tell the user the change did NOT take effect.
 *
 * @param {string[]} list
 * @returns {Promise<void>} resolves only if storage now holds exactly `list`
 * @throws {Error} if the write was rejected or did not take effect
 */
export async function saveAllowlist(list) {
  if (!Array.isArray(list)) {
    throw new TypeError("saveAllowlist expects an array of host entries");
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Observable even if the caller swallows the throw, and it needs no storage
    // of its own -- the same reasoning as the audit log's console signal.
    console.error(
      "[AnythingLLM Companion] failed to save the allowlist; the previous " +
        "list is still in effect:",
      message
    );
    throw new Error(`allowlist not saved: ${message}`);
  }

  // Read back rather than trusting the write. `set` resolving is not proof the
  // value landed as given, and this is the one write in the extension where
  // believing a lie can mean believing access was revoked when it was not.
  const stored = await loadAllowlist();
  const matches =
    stored.length === list.length && stored.every((v, i) => v === list[i]);
  if (!matches) {
    console.error(
      "[AnythingLLM Companion] the allowlist read back differently from " +
        "what was saved; the gate is enforcing:",
      stored
    );
    throw new Error("allowlist not saved: storage did not retain the new list");
  }
}

export { STORAGE_KEY, parseEntry };
