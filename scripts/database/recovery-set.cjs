const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { fileSha256 } = require("./export.cjs");

const MAGIC = Buffer.from("ALLMR2V1");
const HEADER_SIZE = MAGIC.length + 12;
const TAG_SIZE = 16;

function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new Error("Recovery requires a 32-byte independently supplied key.");
}

async function encryptPayload(source, destination, key) {
  validateKey(key);
  if (
    !fs.lstatSync(source).isFile() ||
    path.resolve(source) === path.resolve(destination)
  )
    throw new Error("Invalid encryption paths.");
  const handle = await fs.promises.open(destination, "wx", 0o600);
  try {
    const iv = crypto.randomBytes(12);
    const header = Buffer.concat([MAGIC, iv]);
    await handle.write(header);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    const output = fs.createWriteStream(destination, {
      fd: handle.fd,
      autoClose: false,
      start: HEADER_SIZE,
    });
    await pipeline(fs.createReadStream(source), cipher, output);
    await handle.write(
      cipher.getAuthTag(),
      0,
      TAG_SIZE,
      fs.statSync(destination).size
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    sha256: await fileSha256(destination),
    size: fs.statSync(destination).size,
  };
}

async function decryptPayload(source, destination, key) {
  validateKey(key);
  if (fs.existsSync(destination))
    throw new Error("Recovery destination already exists.");
  const input = await fs.promises.open(source, "r");
  let temporary;
  try {
    const { size } = await input.stat();
    if (size < HEADER_SIZE + TAG_SIZE)
      throw new Error("Invalid encrypted payload.");
    const header = Buffer.alloc(HEADER_SIZE);
    const tag = Buffer.alloc(TAG_SIZE);
    await input.read(header, 0, header.length, 0);
    await input.read(tag, 0, tag.length, size - TAG_SIZE);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Invalid encrypted format.");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.length)
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    temporary =
      destination + ".pending-" + crypto.randomBytes(8).toString("hex");
    const output = fs.createWriteStream(temporary, {
      flags: "wx",
      mode: 0o600,
    });
    try {
      await pipeline(
        size === HEADER_SIZE + TAG_SIZE
          ? Readable.from([])
          : fs.createReadStream(source, {
              start: HEADER_SIZE,
              end: size - TAG_SIZE - 1,
            }),
        decipher,
        output
      );
    } catch {
      throw new Error("Recovery payload authentication failed.");
    }
    // No overwrite: only authenticated plaintext receives the final name.
    await fs.promises.link(temporary, destination);
  } finally {
    await input.close();
    if (temporary) await fs.promises.unlink(temporary).catch(() => {});
  }
  return {
    sha256: await fileSha256(destination),
    size: fs.statSync(destination).size,
  };
}

module.exports = { encryptPayload, decryptPayload };
