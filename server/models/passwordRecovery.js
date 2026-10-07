const { v4 } = require("uuid");
const prisma = require("../utils/prisma");
const bcrypt = require("bcryptjs");

const RecoveryCode = {
  tablename: "recovery_codes",
  writable: [],
  issueForUser: async function (userId, codes) {
    const unseen = {
      id: userId,
      OR: [{ seen_recovery_codes: false }, { seen_recovery_codes: null }],
    };
    // SQLite serializes writers. Keep the condition inside every write and use
    // a batch transaction: an interactive callback can wait behind a second
    // writer while holding the first writer's lock.
    const issue = () =>
      prisma.$transaction([
        prisma.recovery_codes.deleteMany({
          where: { user_id: userId, user: unseen },
        }),
        ...codes.map(
          (code) => prisma.$executeRaw`
        INSERT INTO recovery_codes (user_id, code_hash, createdAt)
        SELECT id, ${code.code_hash}, CURRENT_TIMESTAMP FROM users
        WHERE id = ${userId}
          AND (seen_recovery_codes = false OR seen_recovery_codes IS NULL)
      `
        ),
        prisma.users.updateMany({
          where: unseen,
          data: { seen_recovery_codes: true },
        }),
      ]);
    let results;
    try {
      results = await issue();
    } catch (error) {
      // A concurrent SQLite writer may fail the deferred transaction's lock
      // upgrade immediately. Retry once only after that transaction rolled back.
      if (error.code !== "P2010" || String(error.meta?.code) !== "5")
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
      results = await issue();
    }
    if (results[results.length - 1].count) return true;
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new Error("Failed to generate user recovery codes!");
    return false;
  },
  create: async function (userId, code) {
    try {
      const codeHash = await bcrypt.hash(code, 10);
      const recoveryCode = await prisma.recovery_codes.create({
        data: { user_id: userId, code_hash: codeHash },
      });
      return { recoveryCode, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE RECOVERY CODE.", error.message);
      return { recoveryCode: null, error: error.message };
    }
  },
  createMany: async function (data) {
    try {
      const recoveryCodes = await prisma.$transaction(
        data.map((recoveryCode) =>
          prisma.recovery_codes.create({ data: recoveryCode })
        )
      );
      return { recoveryCodes, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE RECOVERY CODES.", error.message);
      return { recoveryCodes: null, error: error.message };
    }
  },
  findFirst: async function (clause = {}) {
    try {
      const recoveryCode = await prisma.recovery_codes.findFirst({
        where: clause,
      });
      return recoveryCode;
    } catch (error) {
      console.error("FAILED TO FIND RECOVERY CODE.", error.message);
      return null;
    }
  },
  findMany: async function (clause = {}) {
    try {
      const recoveryCodes = await prisma.recovery_codes.findMany({
        where: clause,
      });
      return recoveryCodes;
    } catch (error) {
      console.error("FAILED TO FIND RECOVERY CODES.", error.message);
      return null;
    }
  },
  deleteMany: async function (clause = {}) {
    try {
      await prisma.recovery_codes.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error("FAILED TO DELETE RECOVERY CODES.", error.message);
      return false;
    }
  },
  hashesForUser: async function (userId = null) {
    if (!userId) return [];
    return (await this.findMany({ user_id: userId })).map(
      (recovery) => recovery.code_hash
    );
  },
};

const PasswordResetToken = {
  tablename: "password_reset_tokens",
  resetExpiryMs: 600_000, // 10 minutes in ms;
  writable: [],
  calcExpiry: function () {
    return new Date(Date.now() + this.resetExpiryMs);
  },
  create: async function (userId) {
    try {
      const passwordResetToken = await prisma.password_reset_tokens.create({
        data: { user_id: userId, token: v4(), expiresAt: this.calcExpiry() },
      });
      return { passwordResetToken, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE PASSWORD RESET TOKEN.", error.message);
      return { passwordResetToken: null, error: error.message };
    }
  },
  findUnique: async function (clause = {}) {
    try {
      const passwordResetToken = await prisma.password_reset_tokens.findUnique({
        where: clause,
      });
      return passwordResetToken;
    } catch (error) {
      console.error("FAILED TO FIND PASSWORD RESET TOKEN.", error.message);
      return null;
    }
  },
  deleteMany: async function (clause = {}) {
    try {
      await prisma.password_reset_tokens.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error("FAILED TO DELETE PASSWORD RESET TOKEN.", error.message);
      return false;
    }
  },
};

module.exports = {
  RecoveryCode,
  PasswordResetToken,
};
