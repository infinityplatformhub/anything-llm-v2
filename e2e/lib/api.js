const j = async (r) => { const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };
const hdr = (jwt) => ({ "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) });
module.exports = {
  ping: (base) => fetch(`${base}/api/ping`).then(j),
  setupComplete: (base) => fetch(`${base}/api/setup-complete`).then(j),
  enableMultiUser: (base, username, password) => fetch(`${base}/api/system/enable-multi-user`, { method: "POST", headers: hdr(), body: JSON.stringify({ username, password }) }).then(j),
  login: (base, username, password) => fetch(`${base}/api/request-token`, { method: "POST", headers: hdr(), body: JSON.stringify({ username, password }) }).then(j),
  newUser: (base, jwt, u) => fetch(`${base}/api/admin/users/new`, { method: "POST", headers: hdr(jwt), body: JSON.stringify(u) }).then(j),
  setMembers: (base, jwt, wsId, userIds) => fetch(`${base}/api/admin/workspaces/${wsId}/update-users`, { method: "POST", headers: hdr(jwt), body: JSON.stringify({ userIds }) }).then(j),
  newWorkspace: (base, jwt, name) => fetch(`${base}/api/workspace/new`, { method: "POST", headers: hdr(jwt), body: JSON.stringify({ name }) }).then(j),
  listWorkspaces: (base, jwt) => fetch(`${base}/api/workspaces`, { headers: hdr(jwt) }).then(j),
  apiKey: (base, jwt) => fetch(`${base}/api/admin/generate-api-key`, { method: "POST", headers: hdr(jwt), body: "{}" }).then(j),
  apiKeySingleUser: (base) => fetch(`${base}/api/system/generate-api-key`, { method: "POST", headers: hdr(), body: "{}" }).then(j),
  getSkills: (base, jwt, slug) => fetch(`${base}/api/admin/workspace/${slug}/agent-skills`, { headers: hdr(jwt) }).then(j),
  setSkills: (base, jwt, slug, enabledSkills) => fetch(`${base}/api/admin/workspace/${slug}/agent-skills`, { method: "POST", headers: hdr(jwt), body: JSON.stringify({ enabledSkills }) }).then(j),
  setSystemPref: (base, jwt, obj) => fetch(`${base}/api/admin/system-preferences`, { method: "POST", headers: hdr(jwt), body: JSON.stringify(obj) }).then(j),
  updateWorkspace: (base, jwt, slug, data) => fetch(`${base}/api/workspace/${slug}/update`, { method: "POST", headers: hdr(jwt), body: JSON.stringify(data) }).then(j),
  agentChatV1: (base, key, slug, message) => fetch(`${base}/api/v1/workspace/${slug}/chat`, { method: "POST", headers: hdr(key), body: JSON.stringify({ message: `@agent ${message}`, mode: "chat" }) }).then(j),
  streamChatJwt: async (base, jwt, slug, message) => { const r = await fetch(`${base}/api/workspace/${slug}/stream-chat`, { method: "POST", headers: hdr(jwt), body: JSON.stringify({ message, mode: "chat" }) }); return { status: r.status, body: await r.text() }; },
  uploadDoc: async (base, key, filePath) => { const fd = new FormData(); fd.append("file", new Blob([require("fs").readFileSync(filePath)]), require("path").basename(filePath)); return fetch(`${base}/api/v1/document/upload`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd }).then(j); },
  embed: (base, jwt, slug, adds) => fetch(`${base}/api/workspace/${slug}/update-embeddings`, { method: "POST", headers: hdr(jwt), body: JSON.stringify({ adds, deletes: [] }) }).then(j),
};
