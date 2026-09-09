// The service worker runs as an ES module, so its source is ESM. Jest reads it
// natively under --experimental-vm-modules rather than through a babel transform,
// which would be a second toolchain to keep in step with vite for no gain.
//
// rootDir is pinned so this config behaves the same whether jest is started from
// this directory (`yarn test`) or from the repo root with `--config`.
export default {
  rootDir: ".",
  testEnvironment: "node",
  transform: {},
};
