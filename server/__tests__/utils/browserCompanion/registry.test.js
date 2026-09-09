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

  it("does not report an eviction when the same socket re-registers", () => {
    const s = fakeSocket("same");
    registry.register({ userId: 7, socket: s });
    expect(registry.register({ userId: 7, socket: s }).evicted).toBeNull();
  });

  it("register refuses a missing socket rather than storing a blank entry", () => {
    expect(() => registry.register({ userId: 7 })).toThrow(TypeError);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBeNull();
  });

  it("unregister removes the socket when it is the one still registered", () => {
    const s = fakeSocket("live");
    registry.register({ userId: 7, socket: s });
    registry.unregister({ userId: 7, socket: s });
    const { socket, error } = registry.resolve({ userId: 7, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
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

  // @edge — sentinel ต้องไม่อยู่ keyspace เดียวกับ userId ที่เป็น string
  it("never lets a string userId reach the single-user socket", () => {
    const solo = fakeSocket("solo");
    registry.register({ userId: null, socket: solo });
    const { socket, error } = registry.resolve({
      userId: registry.SINGLE_USER_KEY,
      multiUserMode: true,
    });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  // @edge — ทิศกลับ: ลงทะเบียนด้วย sentinel string ต้องไม่ตกถึง single-user run
  it("never hands a socket registered under the sentinel string to a null-user run", () => {
    registry.register({
      userId: registry.SINGLE_USER_KEY,
      socket: fakeSocket("attacker"),
    });
    const { socket, error } = registry.resolve({ userId: null, multiUserMode: false });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  it("refuses a non-integer userId rather than looking it up", () => {
    registry.register({ userId: 7, socket: fakeSocket("a") });
    const { socket, error } = registry.resolve({ userId: "7", multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  // @edge — multiUserMode ที่หายไปต้องไม่ทำให้ gate ปิดเงียบๆ
  it("throws when multiUserMode is omitted, so the gate cannot fail open", () => {
    registry.register({ userId: null, socket: fakeSocket("legacy") });
    expect(() => registry.resolve({ userId: null })).toThrow(TypeError);
  });

  it("throws when multiUserMode is a non-boolean falsy value", () => {
    registry.register({ userId: null, socket: fakeSocket("legacy") });
    expect(() => registry.resolve({ userId: null, multiUserMode: 0 })).toThrow(
      /explicit boolean multiUserMode/i
    );
  });
});
