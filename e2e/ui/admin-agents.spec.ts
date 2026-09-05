import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const { getSkills, setSkills } = require("../lib/api.js");

const A = "http://localhost:3011";
const jwt = null;
const emptyNote =
  "This workspace has no skills enabled yet. New workspaces start from zero.";

const skillRow = (page: Page, title: string) =>
  page
    .getByText(title, { exact: true })
    .locator('xpath=ancestor::div[@aria-disabled][1]');
const skillRows = (page: Page) =>
  page.locator('[aria-disabled]').filter({ has: page.getByText(/^(On|Off)$/) });

async function expectAllSkillsOff(page: Page) {
  const rows = skillRows(page);
  await expect(rows.first()).toHaveAttribute("aria-disabled", "false");
  const statuses = await rows.getByText(/^(On|Off)$/).allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((status) => status === "Off")).toBe(true);
}

test.beforeEach(async () => {
  for (const slug of ["ws-alpha", "ws-beta"]) {
    const response = await setSkills(A, jwt, slug, []);
    expect(response.status).toBe(200);
  }
});

test("shows selected workspace with every skill off and empty note", async ({
  page,
}) => {
  await page.goto("/settings/agents?workspace=ws-alpha");

  await expect(page.locator("#agent-workspace")).toHaveValue("ws-alpha");
  await expectAllSkillsOff(page);
  await expect(page.getByText(emptyNote, { exact: true })).toBeVisible();
});

test("saves an enabled skill and persists it after reload", async ({ page }) => {
  await page.goto("/settings/agents?workspace=ws-alpha");
  const row = skillRow(page, "RAG & long-term memory");
  await expect(row).toHaveAttribute("aria-disabled", "false");
  await row.click();
  await page.getByRole("checkbox").check({ force: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText(/saved/i)).toBeVisible();
  await page.reload();
  await expect(row.getByText("On", { exact: true })).toBeVisible();
  const response = await getSkills(A, jwt, "ws-alpha");
  expect(response.status).toBe(200);
  expect(response.body.enabledSkills).toEqual(["rag-memory"]);
});

test("keeps skills isolated while switching workspaces", async ({ page }) => {
  expect((await setSkills(A, jwt, "ws-alpha", ["rag-memory"])).status).toBe(200);
  await page.goto("/settings/agents?workspace=ws-alpha");

  await page.locator("#agent-workspace").selectOption("ws-beta");
  await expectAllSkillsOff(page);
  await page.locator("#agent-workspace").selectOption("ws-alpha");
  await expect(
    skillRow(page, "RAG & long-term memory").getByText("On", { exact: true })
  ).toBeVisible();
});

test("cancels an unsaved skill change", async ({ page }) => {
  await page.goto("/settings/agents?workspace=ws-alpha");
  const row = skillRow(page, "Scrape websites");
  await expect(row).toHaveAttribute("aria-disabled", "false");
  await row.click();
  await page.getByRole("checkbox").check({ force: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(row.getByText("Off", { exact: true })).toBeVisible();
  const response = await getSkills(A, jwt, "ws-alpha");
  expect(response.status).toBe(200);
  expect(response.body.enabledSkills).toEqual([]);
});

test("disables skill controls when workspace skills fail to load", async ({
  page,
}) => {
  await page.route("**/api/admin/workspace/*/agent-skills", (route) =>
    route.fulfill({ status: 500, body: "boom" })
  );
  await page.goto("/settings/agents?workspace=ws-alpha");

  const rows = skillRows(page);
  await expect(rows.first()).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  await page.unroute("**/api/admin/workspace/*/agent-skills");
  await page.reload();
  await expect(rows.first()).toHaveAttribute("aria-disabled", "false");
});

test("links workspace agent configuration to the selected workspace skills", async ({
  page,
}) => {
  await page.goto("/workspace/ws-alpha/settings/agent-config");

  await expect(
    page.getByRole("link", { name: "Configure Agent Skills", exact: true })
  ).toHaveAttribute("href", "/settings/agents?workspace=ws-alpha");
});
