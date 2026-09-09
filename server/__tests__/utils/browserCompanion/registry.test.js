/* global jest */
const { describe, it, expect, beforeEach } = require("@jest/globals");
const registry = require("../../../utils/browserCompanion/registry");

function fakeSocket(name) {
  return { name, closed: false, close() { this.closed = true; } };
}

describe("browserCompanion registry", () => {
  beforeEach(() => registry.__reset());

  it("resolves the socket registered for that user", () => {
    const s = fakeSocket("a");
    registry.register({ userId: 7, socket: s });
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(s);
  });

  it("never hands one user's socket to another user", () => {
    registry.register({ userId: 7, socket: fakeSocket("a") });
    const { socket, error } = registry.resolve({ userId: 9, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  it("evicts the previous socket when a second device connects", () => {
    const first = fakeSocket("first");
    registry.register({ userId: 7, socket: first });
    const { evicted } = registry.register({ userId: 7, socket: fakeSocket("second") });
    expect(evicted).toBe(first);
  });

  it("unregister ignores a stale socket so it cannot drop the live one", () => {
    const stale = fakeSocket("stale");
    registry.register({ userId: 7, socket: stale });
    const live = fakeSocket("live");
    registry.register({ userId: 7, socket: live });
    registry.unregister({ userId: 7, socket: stale });
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(live);
  });

  // @edge — null user_id key ต้องใช้ไม่ได้เมื่อเปิด multi-user mode
  it("refuses a null-user key in multi-user mode", () => {
    registry.register({ userId: null, socket: fakeSocket("legacy") });
    const { socket, error } = registry.resolve({ userId: null, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/multi-user/i);
  });

  it("allows the null-user key in single-user mode", () => {
    const s = fakeSocket("solo");
    registry.register({ userId: null, socket: s });
    expect(registry.resolve({ userId: null, multiUserMode: false }).socket).toBe(s);
  });

  // @edge — agent ที่ไม่มี user ห้ามยืมเบราว์เซอร์ของคนที่บังเอิญออนไลน์
  it("refuses to resolve for an agent with no user in multi-user mode", () => {
    registry.register({ userId: 7, socket: fakeSocket("a") });
    const { socket, error } = registry.resolve({ userId: undefined, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/no user/i);
  });
});
