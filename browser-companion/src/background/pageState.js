/**
 * The element map: what the agent is allowed to know about a page, and the only
 * way it can name something to act on.
 *
 * WHY IDS AND NOT SELECTORS
 *
 * The agent never sends a selector or a coordinate. It sends an `[id]` from the
 * most recent capture, and this module turns that back into a viewport point.
 * A compromised server therefore cannot aim a click at an arbitrary pixel — it
 * can only pick from elements this extension already decided to expose, on a
 * page the allowlist already admitted.
 *
 * THE MAP GOES STALE, AND THAT IS THE DANGEROUS PART
 *
 * Ids are positional. Once the page moves — a scroll, a keystroke that submits,
 * a navigation, or the site's own async render — id 12 may be a different
 * element at the same coordinates. Acting on a stale map is how an agent clicks
 * "Delete" believing it clicked "Message". So the map is invalidated eagerly by
 * `dispatch.js` after anything known to move the page, and a lookup miss is
 * reported to the agent as an instruction to call page_state again rather than
 * as a bare failure.
 */
import { evaluate } from "./cdp.js";

// Cap the map so a huge page cannot crowd out the model's context. The agent
// can scroll and re-read; a truncated 5000-element dump would just be a worse
// map. A true constant — it is a property of model context, not of any
// deployment.
const MAX_ELEMENTS = 150;

// Ceiling on one page_read. Same reasoning as MAX_ELEMENTS.
const MAX_TEXT_CHARS = 20_000;

// Text kept per element. Long enough to tell two buttons apart, short enough
// that 150 of them stay readable.
const MAX_LABEL_CHARS = 120;

const CAPTURE_EXPRESSION = `(() => {
  const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
  const out = [];
  let id = 1;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    // A zero-area box is not clickable, and an off-screen one would be clicked
    // at coordinates belonging to whatever is actually there.
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > innerHeight) continue;
    if (rect.right < 0 || rect.left > innerWidth) continue;
    if (el.disabled === true) continue;
    const label = (
      el.innerText ||
      el.value ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      ''
    ).replace(/\\s+/g, ' ').trim().slice(0, ${MAX_LABEL_CHARS});
    out.push({
      id: id++,
      tag: el.tagName.toLowerCase(),
      text: label,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
    if (out.length >= ${MAX_ELEMENTS}) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

// ponytail: page_read renders a shallow markdown — headings, list items, links,
// everything else as a paragraph. It does not handle tables, nested lists, or
// code blocks, and it reads the whole body rather than picking the article. The
// ceiling is "text a model can follow", not "faithful markdown". Upgrade path
// when that is not enough: bundle a Readability + turndown pass into the
// content script rather than growing this string.
const READ_EXPRESSION = `(() => {
  const parts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const seen = new Set();
  for (const el of document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,a,td,th,blockquote')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const tag = el.tagName.toLowerCase();
    let line;
    if (/^h[1-6]$/.test(tag)) line = '#'.repeat(Number(tag[1])) + ' ' + text;
    else if (tag === 'li') line = '- ' + text;
    else if (tag === 'blockquote') line = '> ' + text;
    else if (tag === 'a') line = el.href ? '[' + text + '](' + el.href + ')' : text;
    else line = text;
    // A paragraph's text also appears inside its links and vice versa; the seen
    // set is what stops the same sentence being emitted several times.
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }
  const body = parts.join('\\n\\n');
  return {
    url: location.href,
    title: document.title,
    text: body.length > ${MAX_TEXT_CHARS}
      ? body.slice(0, ${MAX_TEXT_CHARS}) + '\\n\\n…[truncated — scroll or narrow the page to read more]'
      : body,
  };
})()`;

/**
 * tabId → (element id → viewport point).
 *
 * Module-level, and therefore lost when the MV3 service worker is torn down
 * after ~30s idle. That is the correct failure: a map that survived a teardown
 * would be a map of a page that has had at least 30 seconds to change. A lookup
 * after a teardown misses and the agent is told to call page_state again, which
 * is exactly what it should do.
 *
 * @type {Map<number, Map<number, {x: number, y: number}>>}
 */
const maps = new Map();

/**
 * Photograph the page's actionable elements and remember where they are.
 *
 * @param {number} tabId
 * @returns {Promise<{url: string, title: string, elements: Array<{id: number, tag: string, text: string, x: number, y: number}>}>}
 */
export async function capture(tabId) {
  const state = await evaluate(tabId, CAPTURE_EXPRESSION);
  const points = new Map();
  for (const el of state?.elements ?? []) points.set(el.id, { x: el.x, y: el.y });
  // Replaced wholesale, never merged: a merge would leave ids from the previous
  // page resolvable, which is the stale-map hazard with extra steps.
  maps.set(tabId, points);
  return state;
}

/**
 * @param {number} tabId
 * @returns {Promise<{url: string, title: string, text: string}>}
 */
export async function read(tabId) {
  return await evaluate(tabId, READ_EXPRESSION);
}

/**
 * Resolve an id from the most recent capture of this tab.
 *
 * @param {number} tabId
 * @param {unknown} id as it arrived from the socket — untrusted
 * @returns {Promise<{x: number, y: number} | null>} null when there is no map
 *   for this tab, or the id is not in it, or the id is not a number at all.
 *   Every one of those means the same thing to the caller: re-read the page.
 */
export async function lookup(tabId, id) {
  // `Number(id)` alone would turn "" and null into 0 and an array `[12]` into
  // 12, so an id the agent never sent could resolve to a real element.
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  return maps.get(tabId)?.get(id) ?? null;
}

/**
 * Drop the map for a tab, because the page has moved under it.
 *
 * Called by `dispatch.js` after every command that can change the layout. The
 * alternative — trusting the agent to re-capture because the tool description
 * told it to — is trusting a remote model to be careful with a click.
 *
 * @param {number} tabId
 */
export function invalidate(tabId) {
  maps.delete(tabId);
}

/** @param {number} tabId @returns {boolean} whether a map exists right now. */
export function hasMap(tabId) {
  return maps.has(tabId);
}

export { MAX_ELEMENTS, MAX_TEXT_CHARS, MAX_LABEL_CHARS };
