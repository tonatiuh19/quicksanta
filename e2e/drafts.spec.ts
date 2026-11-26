import { expect, test } from "@playwright/test";
import { cleanup, makeUser, noSidewaysScroll, pool, SHOTS, signInAs } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await cleanup();
});

const dbDraft = async (userId: number) => {
  const [rows] = (await pool.query("SELECT step, data FROM wizard_drafts WHERE user_id = ?", [userId])) as any;
  return rows[0] ? { step: rows[0].step, data: typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data } : null;
};

async function startDraft(page: import("@playwright/test").Page, name: string) {
  await page.goto("/start");
  await page.getByRole("radio", { name: /^secret santa/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/exchange name/i).fill(name);
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByLabel("Your name")).toBeVisible(); // people step
}

test("signed out: draft survives a reload, resume screen continues on the same step", async ({ page }) => {
  await startDraft(page, "PW Browser Draft");
  await page.reload();
  await expect(page.getByText("Pick up where you left off")).toBeVisible();
  const card = page.getByRole("article", { name: /unfinished exchange draft/i });
  await expect(card.getByRole("heading", { name: "PW Browser Draft" })).toBeVisible();
  await expect(card.getByText(/saved in this browser/i)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/drafts-01-resume.png`, fullPage: true });
  await card.getByRole("button", { name: /^continue/i }).click();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await expect(page.getByLabel(/exchange name/i)).toHaveCount(0);
});

test("signing in moves the browser draft into the account; another device sees it on the dashboard", async ({ page, context, browser }) => {
  const u = await makeUser("drafter");
  await startDraft(page, "PW Moves In");
  await signInAs(context, u);
  await page.goto("/app");
  await expect.poll(async () => (await dbDraft(u.id))?.data?.name, { timeout: 10_000 }).toBe("PW Moves In");
  expect((await dbDraft(u.id))!.step).toBe("people");

  // "Another device": fresh browser storage, same account.
  const other = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  await signInAs(other, u);
  const phone = await other.newPage();
  await phone.goto("/app");
  const card = phone.getByRole("article", { name: /unfinished exchange draft/i });
  await expect(card.getByRole("heading", { name: "PW Moves In" })).toBeVisible();
  await expect(card.getByText(/saved to your account/i)).toBeVisible();
  await noSidewaysScroll(phone);
  await phone.screenshot({ path: `${SHOTS}/drafts-02-dashboard-mobile.png`, fullPage: true });

  // Edit on the phone → autosaved to the account.
  await card.getByRole("button", { name: /^continue/i }).click();
  await expect(phone.getByLabel("Your name")).toBeVisible();
  await phone.getByRole("button", { name: /back/i }).click();
  await phone.getByLabel(/exchange name/i).fill("PW Edited On Phone");
  await expect.poll(async () => (await dbDraft(u.id))?.data?.name, { timeout: 10_000 }).toBe("PW Edited On Phone");

  // Logout clears the phone's browser copy but keeps the account copy.
  await phone.evaluate(() => localStorage.getItem("qs_wizard_draft")).then((v) => expect(v).toBeTruthy());
  await other.close();
  expect((await dbDraft(u.id))?.data?.name).toBe("PW Edited On Phone");

  // Back on the desktop: the newer account draft wins after a reload.
  await page.evaluate(() => localStorage.removeItem("qs_wizard_draft"));
  await page.goto("/start");
  await expect(page.getByRole("heading", { name: "PW Edited On Phone" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/drafts-03-resume-account.png`, fullPage: true });

  // Start new (two-step) → account copy deleted.
  await page.getByRole("button", { name: /start a new exchange/i }).click();
  await page.getByRole("button", { name: /yes, delete it/i }).click();
  await expect(page.getByRole("radio", { name: /^secret santa/i })).toBeVisible();
  await expect.poll(() => dbDraft(u.id), { timeout: 10_000 }).toBeNull();
});
