const { describe, it, expect, beforeAll, afterAll } = require("@jest/globals");
require("../../utils/lark/_polyfill");
const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const prisma = require("../../../utils/prisma");
const caller = require("../../../utils/MCP/personalCaller");
let workspace;
const users = {};

beforeAll(async () => {
  process.env.JWT_SECRET = "personal-caller-fixture";
  workspace = await prisma.workspaces.create({
    data: { name: "Personal caller access", slug: crypto.randomUUID() },
  });
  for (const [name, role] of Object.entries({
    admin: "admin",
    manager: "manager",
    member: "default",
    outsider: "default",
  })) {
    users[name] = await prisma.users.create({
      data: { username: name + crypto.randomUUID(), password: "unused", role },
    });
  }
  await prisma.workspace_users.create({
    data: { workspace_id: workspace.id, user_id: users.member.id },
  });
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  await prisma.users.deleteMany({
    where: { id: { in: Object.values(users).map((user) => user.id) } },
  });
  await prisma.$disconnect();
});

function response(user) {
  return { locals: { user, browserSessionUserId: user.id } };
}

describe("personal caller follows current workspace access", () => {
  it.each(["admin", "manager", "member"])(
    "%s receives only its own verified caller",
    async (name) => {
      const user = users[name];
      const identity = await caller.fromResponse(response(user), workspace);
      expect(identity).toEqual({ userId: user.id, workspaceId: workspace.id });
      expect(await caller.assert(identity, workspace)).toBe(user.id);
      const oauthIdentity = await caller.fromOAuthState(user.id, workspace);
      expect(await caller.assert(oauthIdentity, workspace)).toBe(user.id);
      const socketIdentity = await caller.fromSocket(
        {
          headers: {
            authorization:
              "Bearer " + JWT.sign({ id: user.id }, process.env.JWT_SECRET),
          },
        },
        { workspace, user_id: user.id }
      );
      expect(await caller.assert(socketIdentity, workspace)).toBe(user.id);
    }
  );
  it("rejects an outsider even with a forged admin role in response locals", async () => {
    await expect(
      caller.fromResponse(
        response({ ...users.outsider, role: "admin" }),
        workspace
      )
    ).rejects.toThrow("personal_auth_required");
  });
  it.each(["admin", "manager", "member"])(
    "suspension revokes %s identities and prevents new identities",
    async (name) => {
      const user = users[name];
      const identity = await caller.fromResponse(response(user), workspace);
      await prisma.users.update({
        where: { id: user.id },
        data: { suspended: 1 },
      });
      try {
        await expect(caller.assert(identity, workspace)).rejects.toThrow(
          "personal_auth_required"
        );
        await expect(
          caller.fromResponse(response(user), workspace)
        ).rejects.toThrow("personal_auth_required");
      } finally {
        await prisma.users.update({
          where: { id: user.id },
          data: { suspended: 0 },
        });
      }
    }
  );
  it.each(["admin", "manager"])(
    "downgrading %s revokes an already-issued caller without membership",
    async (name) => {
      const user = users[name];
      const identity = await caller.fromResponse(response(user), workspace);
      await prisma.users.update({
        where: { id: user.id },
        data: { role: "default" },
      });
      try {
        await expect(caller.assert(identity, workspace)).rejects.toThrow(
          "personal_auth_required"
        );
        await expect(
          caller.fromResponse(response(user), workspace)
        ).rejects.toThrow("personal_auth_required");
      } finally {
        await prisma.users.update({
          where: { id: user.id },
          data: { role: user.role },
        });
      }
    }
  );
  it.each(["admin", "manager", "member"])(
    "%s cannot authenticate to a deleted workspace",
    async (name) => {
      const deleted = await prisma.workspaces.create({
        data: { name: "Deleted caller workspace", slug: crypto.randomUUID() },
      });
      await prisma.workspaces.delete({ where: { id: deleted.id } });
      await expect(
        caller.fromResponse(response(users[name]), deleted)
      ).rejects.toThrow("personal_auth_required");
    }
  );
  it.each(["admin", "manager"])(
    "deleting a workspace revokes an issued %s identity",
    async (name) => {
      const deleted = await prisma.workspaces.create({
        data: { name: "Revoked caller workspace", slug: crypto.randomUUID() },
      });
      const identity = await caller.fromResponse(
        response(users[name]),
        deleted
      );
      await prisma.workspaces.delete({ where: { id: deleted.id } });
      await expect(caller.assert(identity, deleted)).rejects.toThrow(
        "personal_auth_required"
      );
    }
  );
  it("removing membership revokes the ordinary member caller", async () => {
    const user = users.member;
    const identity = await caller.fromResponse(response(user), workspace);
    await prisma.workspace_users.deleteMany({
      where: { workspace_id: workspace.id, user_id: user.id },
    });
    try {
      await expect(caller.assert(identity, workspace)).rejects.toThrow(
        "personal_auth_required"
      );
    } finally {
      await prisma.workspace_users.create({
        data: { workspace_id: workspace.id, user_id: user.id },
      });
    }
  });
  it("a browserless or forged identity cannot use privileged access", async () => {
    await expect(
      caller.fromResponse({ locals: { user: users.admin } }, workspace)
    ).rejects.toThrow("personal_auth_required");
    await expect(
      caller.assert(
        { userId: users.admin.id, workspaceId: workspace.id },
        workspace
      )
    ).rejects.toThrow("personal_auth_required");
    await expect(
      caller.fromSocket(
        { headers: {}, body: { userId: users.admin.id } },
        { workspace, user_id: users.admin.id }
      )
    ).rejects.toThrow("personal_auth_required");
  });
  it("an admin socket still cannot impersonate another invocation owner", async () => {
    await expect(
      caller.fromSocket(
        {
          headers: {
            authorization:
              "Bearer " +
              JWT.sign({ id: users.admin.id }, process.env.JWT_SECRET),
          },
        },
        { workspace, user_id: users.member.id }
      )
    ).rejects.toThrow("personal_auth_required");
  });
});
