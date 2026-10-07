const fs = require("fs");
const os = require("os");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-atomic-"));
const mockPrisma = new PrismaClient({
  datasources: { db: { url: `file:${directory}/fixture.db` } },
});
jest.mock("../../utils/prisma", () => mockPrisma);
const { generateRecoveryCodes } = require("../../utils/PasswordRecovery");

beforeAll(async () => {
  await mockPrisma.$executeRawUnsafe(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, password TEXT NOT NULL,
    seen_recovery_codes BOOLEAN, role TEXT DEFAULT 'default', suspended INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, lastUpdatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    pfpFilename TEXT, dailyMessageLimit INTEGER, bio TEXT, web_push_subscription_config TEXT)`);
  await mockPrisma.$executeRawUnsafe(`CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});
beforeEach(async () => {
  await mockPrisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_update");
  await mockPrisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_insert");
  await mockPrisma.recovery_codes.deleteMany();
  await mockPrisma.users.deleteMany();
  await mockPrisma.users.create({
    data: { id: 1, password: "fixture", seen_recovery_codes: false },
  });
});
afterAll(async () => {
  await mockPrisma.$disconnect();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("does not leave undisclosed codes when updating the user fails", async () => {
  await mockPrisma.$executeRawUnsafe(`CREATE TRIGGER fail_update BEFORE UPDATE ON users
    BEGIN SELECT RAISE(ABORT, 'controlled update failure'); END`);
  await expect(generateRecoveryCodes(1)).rejects.toThrow();
  expect(await mockPrisma.recovery_codes.count()).toBe(0);
  expect(
    (await mockPrisma.users.findUnique({ where: { id: 1 } }))
      .seen_recovery_codes
  ).toBe(false);
});

it("rolls back the seen flag when storing a code fails", async () => {
  await mockPrisma.$executeRawUnsafe(`CREATE TRIGGER fail_insert BEFORE INSERT ON recovery_codes
    BEGIN SELECT RAISE(ABORT, 'controlled insert failure'); END`);
  await expect(generateRecoveryCodes(1)).rejects.toThrow();
  expect(await mockPrisma.recovery_codes.count()).toBe(0);
  expect(
    (await mockPrisma.users.findUnique({ where: { id: 1 } }))
      .seen_recovery_codes
  ).toBe(false);
});

it("stores exactly the four codes returned to the winning concurrent login", async () => {
  const results = await Promise.allSettled([
    generateRecoveryCodes(1),
    generateRecoveryCodes(1),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const codes = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);
  expect(codes).toHaveLength(4);
  const stored = await mockPrisma.recovery_codes.findMany();
  expect(stored).toHaveLength(4);
  for (const code of codes)
    expect(stored.some((row) => bcrypt.compareSync(code, row.code_hash))).toBe(
      true
    );
  expect(
    (await mockPrisma.users.findUnique({ where: { id: 1 } }))
      .seen_recovery_codes
  ).toBe(true);
});

it("does not generate another set after codes have already been issued", async () => {
  await generateRecoveryCodes(1);
  expect(await generateRecoveryCodes(1)).toEqual([]);
  expect(await mockPrisma.recovery_codes.count()).toBe(4);
});

it("replaces undisclosed codes left by a previous failed first login", async () => {
  await mockPrisma.recovery_codes.create({
    data: { user_id: 1, code_hash: "undisclosed-old-code" },
  });
  expect(await generateRecoveryCodes(1)).toHaveLength(4);
  expect(await mockPrisma.recovery_codes.count()).toBe(4);
  expect(
    await mockPrisma.recovery_codes.findFirst({
      where: { code_hash: "undisclosed-old-code" },
    })
  ).toBeNull();
});

it("rolls back previously inserted codes when a later insert fails", async () => {
  await mockPrisma.$executeRawUnsafe(`CREATE TRIGGER fail_insert BEFORE INSERT ON recovery_codes
    WHEN (SELECT COUNT(*) FROM recovery_codes) > 0
    BEGIN SELECT RAISE(ABORT, 'controlled later insert failure'); END`);
  await expect(generateRecoveryCodes(1)).rejects.toThrow();
  expect(await mockPrisma.recovery_codes.count()).toBe(0);
  expect(
    (await mockPrisma.users.findUnique({ where: { id: 1 } }))
      .seen_recovery_codes
  ).toBe(false);
});

it("does not issue codes for a deleted user", async () => {
  await expect(generateRecoveryCodes(999)).rejects.toThrow();
  expect(await mockPrisma.recovery_codes.count()).toBe(0);
});
