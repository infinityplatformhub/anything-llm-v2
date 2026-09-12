/** @type {import('jest').Config} */
module.exports = {
  testPathIgnorePatterns: [
    "/node_modules/",
    "/open-computer/",
    "/e2e/",
    // browser-companion's tests are ESM and need --experimental-vm-modules, which
    // this root run does not set. They have their own config and are run by
    // `cd browser-companion && yarn test`; collecting them here would only ever
    // report "Cannot use import statement outside a module".
    "/browser-companion/__tests__/",
  ],
};
