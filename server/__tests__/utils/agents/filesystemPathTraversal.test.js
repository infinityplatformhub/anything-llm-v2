/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

// The filesystem tool is rooted at $STORAGE_DIR/anythingllm-fs. Anything that
// resolves outside that root must be refused — including relative traversal
// (`../secret.txt`) and absolute paths. The E2E suite cannot prove this on its
// own: whether the model calls the read tool is model behavior, so a green E2E
// run may simply mean the tool was never invoked. This asserts the guard
// directly against a real file that really exists outside the root.
describe("filesystem agent path traversal", () => {
  let storageRoot;
  let filesystem;
  const previousStorageDir = process.env.STORAGE_DIR;
  const CANARY = "CANARY-OUTSIDE-FS-ROOT-4417";

  beforeAll(() => {
    // realpath because macOS resolves /var to /private/var, and the guard
    // compares against the resolved path.
    storageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-fs-test-"))
    );
    fs.mkdirSync(path.join(storageRoot, "anythingllm-fs"), { recursive: true });
    // The canary sits one level above the root, so "../outside.txt" reaches it.
    fs.writeFileSync(path.join(storageRoot, "outside.txt"), `${CANARY}\n`);

    process.env.STORAGE_DIR = storageRoot;
    jest.resetModules();
    filesystem = require("../../../utils/agents/aibitat/plugins/filesystem/lib.js");
  });

  afterAll(() => {
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  test("a file inside the root is allowed", async () => {
    const inside = path.join(storageRoot, "anythingllm-fs", "note.txt");
    fs.writeFileSync(inside, "hello\n");
    await expect(filesystem.validatePath("note.txt")).resolves.toBe(
      fs.realpathSync(inside)
    );
  });

  test.each([
    ["relative traversal", "../outside.txt"],
    ["nested relative traversal", "sub/../../outside.txt"],
    ["deep relative traversal", "../../../../etc/passwd"],
  ])("%s is refused", async (_label, target) => {
    await expect(filesystem.validatePath(target)).rejects.toThrow(
      /Access denied - path outside allowed directories/
    );
  });

  test("an absolute path outside the root is refused", async () => {
    await expect(
      filesystem.validatePath(path.join(storageRoot, "outside.txt"))
    ).rejects.toThrow(/Access denied - path outside allowed directories/);
  });

  test("the canary is readable on disk, so the refusals are not absence", () => {
    expect(fs.readFileSync(path.join(storageRoot, "outside.txt"), "utf8")).toContain(
      CANARY
    );
  });
});
