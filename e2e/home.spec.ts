import { expect, test } from "@playwright/test";
import { noSidewaysScroll, pool, SHOTS } from "./helpers";

const shot = async (page: import("@playwright/test").Page, sel: string, name: string) => {
  const el = page.locator(sel);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700); // let entry animations settle
  await el.screenshot({ path: `${SHOTS}/${name}.png` });
};

for (const vp of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
  { name: "small", width: 320, height: 640 },
]) {
  test(`home sections render without sideways scroll (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /share one link\. everyone's in\./i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /invent your own tradition/i })).toBeVisible();
    await noSidewaysScroll(page);
    if (vp.name !== "small") {
      await shot(page, ".qs-code-strip", `home-${vp.name}-01-code-strip`);
      await shot(page, "#invite-link", `home-${vp.name}-02-invite`);
      await shot(page, "#create-your-own", `home-${vp.name}-03-custom`);
    }
  });
}

test("home: code strip → join page; Enterprise form reaches Command Center leads", async ({ page }) => {
  await page.goto("/");
  await page.locator(".qs-code-strip").getByLabel(/invite code/i).fill("zzzzzzzz");
  await page.locator(".qs-code-strip").getByRole("button", { name: /^join/i }).click();
  await expect(page).toHaveURL(/\/j\/ZZZZ-ZZZZ$/);
  await expect(page.getByText(/couldn't find that exchange/i)).toBeVisible();

  await page.goto("/#contact");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/your name/i)).toBeFocused();
  const email = `qsit-e2e-lead-${Date.now()}@example.com`;
  await dialog.getByLabel(/your name/i).fill("PW Lead");
  await dialog.getByLabel(/work email/i).fill(email);
  await dialog.getByLabel(/company/i).fill("PW Corp");
  await dialog.getByLabel(/how many people/i).selectOption("100_500");
  await page.screenshot({ path: `${SHOTS}/home-04-contact.png` });
  await dialog.getByRole("button", { name: /^send/i }).click();
  await expect(dialog.getByText(/thanks! we got it/i)).toBeVisible();
  const [rows] = (await pool.query("SELECT company, team_size, status FROM contact_requests WHERE email = ?", [email])) as any;
  expect(rows[0]).toMatchObject({ company: "PW Corp", team_size: "100_500", status: "new" });
  await pool.query("DELETE FROM contact_requests WHERE email = ?", [email]);
});
