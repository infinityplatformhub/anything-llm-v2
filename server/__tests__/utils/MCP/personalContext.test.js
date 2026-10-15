require("../../utils/lark/_polyfill");
const prisma = require("../../../utils/prisma");
const crypto = require("crypto");
const {
  WorkspaceAgentInvocation: Invocation,
} = require("../../../models/workspaceAgentInvocation");
let Context, workspace, user;
beforeAll(async () => {
  workspace = await prisma.workspaces.create({
    data: { name: "Private context", slug: crypto.randomUUID() },
  });
  user = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "fixture" },
  });
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
test("durable privacy scope survives fresh module and has stable null-thread boundary", async () => {
  Context = require("../../../models/personalMcpContext").PersonalMcpContext;
  const invocation = {
    workspace_id: workspace.id,
    user_id: user.id,
    thread_id: null,
  };
  expect(await Context.has(invocation)).toBe(false);
  await Context.mark(invocation);
  expect(await Context.has({ ...invocation })).toBe(true);
  expect(await Context.has({ ...invocation, thread_id: 42 })).toBe(false);
  expect(await Context.has({ ...invocation, user_id: user.id + 1 })).toBe(
    false
  );
});
test("marking first private exposure encrypts the persisted current invocation prompt", async () => {
  const invocation = await prisma.workspace_agent_invocations.create({
    data: {
      uuid: crypto.randomUUID(),
      workspace_id: workspace.id,
      user_id: user.id,
      prompt: "first-private-owner-input",
    },
  });
  await Context.mark(invocation);
  const stored = await prisma.workspace_agent_invocations.findUnique({
    where: { uuid: invocation.uuid },
  });
  expect(stored.prompt).toMatch(/^personal-mcp-encrypted:/);
  expect(stored.prompt).not.toContain("first-private-owner-input");
});
test("deferred create concurrent with durable mark publishes encrypted prompt only", async () => {
  const thread = 743;
  const create = prisma.workspace_agent_invocations.create.bind(
    prisma.workspace_agent_invocations
  );
  let finish, entered;
  const ready = new Promise((resolve) => (entered = resolve));
  const spy = jest
    .spyOn(prisma.workspace_agent_invocations, "create")
    .mockImplementation(async (input) => {
      entered();
      await new Promise((resolve) => (finish = resolve));
      return create(input);
    });
  const pending = Invocation.new({
    workspace,
    user,
    thread: { id: thread },
    prompt: "fixture-followup-sensitive",
  });
  await ready;
  await Context.mark({
    workspace_id: workspace.id,
    user_id: user.id,
    thread_id: thread,
  });
  finish();
  const { invocation } = await pending;
  spy.mockRestore();
  const stored = await prisma.workspace_agent_invocations.findUnique({
    where: { uuid: invocation.uuid },
  });
  expect(stored.prompt).toMatch(/^personal-mcp-encrypted:/);
  expect(invocation.prompt).not.toContain("fixture-followup-sensitive");
});
