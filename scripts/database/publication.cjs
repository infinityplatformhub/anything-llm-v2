const fs = require("node:fs");
const path = require("node:path");
const { encryptPayload, decryptPayload } = require("./recovery-set.cjs");
const { fileSha256 } = require("./export.cjs");

function name(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value) ||
    ["manifest", "complete"].includes(value)
  )
    throw new Error("Invalid recovery name.");
  return value;
}

function prefix(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,200}$/.test(value) ||
    value.endsWith("/")
  )
    throw new Error("Invalid recovery prefix.");
  return value;
}

async function publishRecoverySet(transport, request) {
  prefix(request.prefix);
  if (
    !Array.isArray(request.payloads) ||
    !request.payloads.length ||
    new Set(request.payloads.map((payload) => name(payload.name))).size !==
      request.payloads.length
  )
    throw new Error("Invalid recovery payload set.");
  const directory = fs.mkdtempSync(path.join(request.directory, "publish-"));
  const object = (file) => request.prefix + "/" + file;
  for (const file of [
    ...request.payloads.map((payload) => name(payload.name) + ".enc"),
    "manifest.enc",
    "complete.enc",
  ]) {
    if (await transport.exists(object(file)))
      throw new Error("Recovery prefix is already populated.");
  }
  const manifest = {
    version: 1,
    prefix: request.prefix,
    source: request.source,
    payloads: [],
  };
  async function publish(file, encrypted) {
    const expected = await fileSha256(encrypted);
    await transport.put(object(file), encrypted);
    const downloaded = path.join(directory, file + ".download");
    await transport.get(object(file), downloaded);
    if ((await fileSha256(downloaded)) !== expected)
      throw new Error("Downloaded recovery checksum mismatch.");
    return downloaded;
  }
  for (const payload of request.payloads) {
    const file = name(payload.name) + ".enc";
    const encrypted = path.join(directory, file);
    const plainSha256 = await fileSha256(payload.path);
    await encryptPayload(payload.path, encrypted, request.key);
    const downloaded = await publish(file, encrypted);
    const checked = path.join(directory, payload.name + ".checked");
    await decryptPayload(downloaded, checked, request.key);
    if (
      (await fileSha256(checked)) !== plainSha256 ||
      (await fileSha256(payload.path)) !== plainSha256
    )
      throw new Error("Recovery source identity changed.");
    manifest.payloads.push({
      name: payload.name,
      object: object(file),
      plainSha256,
      encryptedSha256: await fileSha256(encrypted),
      size: fs.statSync(encrypted).size,
    });
  }
  const manifestPlain = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPlain, JSON.stringify(manifest), {
    flag: "wx",
    mode: 0o600,
  });
  const manifestEncrypted = path.join(directory, "manifest.enc");
  await encryptPayload(manifestPlain, manifestEncrypted, request.key);
  const downloadedManifest = await publish("manifest.enc", manifestEncrypted);
  const checkedManifest = path.join(directory, "manifest.checked");
  await decryptPayload(downloadedManifest, checkedManifest, request.key);
  if ((await fileSha256(checkedManifest)) !== (await fileSha256(manifestPlain)))
    throw new Error("Manifest verification failed.");
  const completion = path.join(directory, "complete.json");
  fs.writeFileSync(
    completion,
    JSON.stringify({
      version: 1,
      prefix: request.prefix,
      manifestSha256: await fileSha256(manifestEncrypted),
    }),
    { flag: "wx", mode: 0o600 }
  );
  const completionEncrypted = path.join(directory, "complete.enc");
  await encryptPayload(completion, completionEncrypted, request.key);
  await publish("complete.enc", completionEncrypted);
  return {
    status: "VERIFIED",
    prefix: request.prefix,
    manifestSha256: await fileSha256(manifestEncrypted),
  };
}

async function restoreRecoverySet(transport, request) {
  prefix(request.prefix);
  fs.mkdirSync(request.directory, { mode: 0o700 }); // Fresh destination only.
  const directory = request.directory;
  const markerEncrypted = path.join(directory, "complete.enc");
  await transport.get(request.prefix + "/complete.enc", markerEncrypted);
  const markerPlain = path.join(directory, "complete.json");
  await decryptPayload(markerEncrypted, markerPlain, request.key);
  const marker = JSON.parse(fs.readFileSync(markerPlain, "utf8"));
  if (
    marker.version !== 1 ||
    marker.prefix !== request.prefix ||
    !/^[a-f0-9]{64}$/.test(marker.manifestSha256 || "")
  )
    throw new Error("Invalid completion marker.");
  const manifestEncrypted = path.join(directory, "manifest.enc");
  await transport.get(request.prefix + "/manifest.enc", manifestEncrypted);
  if ((await fileSha256(manifestEncrypted)) !== marker.manifestSha256)
    throw new Error("Manifest checksum mismatch.");
  const manifestPlain = path.join(directory, "manifest.json");
  await decryptPayload(manifestEncrypted, manifestPlain, request.key);
  const manifest = JSON.parse(fs.readFileSync(manifestPlain, "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.prefix !== request.prefix ||
    !Array.isArray(manifest.payloads) ||
    !manifest.payloads.length ||
    new Set(manifest.payloads.map((payload) => name(payload.name))).size !==
      manifest.payloads.length
  )
    throw new Error("Invalid manifest.");
  const staged = [];
  for (const payload of manifest.payloads) {
    name(payload.name);
    if (
      payload.object !== request.prefix + "/" + payload.name + ".enc" ||
      !/^[a-f0-9]{64}$/.test(payload.plainSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(payload.encryptedSha256 || "")
    )
      throw new Error("Invalid payload identity.");
    const encrypted = path.join(directory, payload.name + ".enc");
    await transport.get(payload.object, encrypted);
    if (
      fs.statSync(encrypted).size !== payload.size ||
      (await fileSha256(encrypted)) !== payload.encryptedSha256
    )
      throw new Error("Payload checksum mismatch.");
    const pending = path.join(directory, payload.name + ".verified");
    await decryptPayload(encrypted, pending, request.key);
    if ((await fileSha256(pending)) !== payload.plainSha256)
      throw new Error("Recovered plaintext checksum mismatch.");
    staged.push({ name: payload.name, pending });
  }
  const payloads = {};
  for (const payload of staged) {
    const destination = path.join(directory, payload.name);
    fs.linkSync(payload.pending, destination);
    payloads[payload.name] = destination;
  }
  return { status: "VERIFIED", source: manifest.source, payloads };
}

module.exports = { publishRecoverySet, restoreRecoverySet };
