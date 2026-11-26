import { expect, test } from "@playwright/test";
import { cleanup, makeUser, noSidewaysScroll, SHOTS, signInAs } from "./helpers";

test.afterAll(async () => {
  await cleanup();
});

test("phone: landing, wizard and workspace fit without sideways scroll; tab bar + More sheet", async ({ page, context }) => {
  await page.goto("/");
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/m1-landing.png`, fullPage: true });
  const u = await makeUser("mobile", "owner");
  await signInAs(context, u);
  await page.goto("/start");
  await noSidewaysScroll(page);
  await page.getByRole("radio", { name: /^secret santa/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/m2-wizard.png`, fullPage: true });
  await page.goto("/admin");
  const tabbar = page.getByRole("navigation", { name: /quick navigation/i });
  await expect(tabbar).toBeVisible();
  await expect(page.locator(".portal-mobile-bar")).toBeVisible();
  await noSidewaysScroll(page);
  await tabbar.getByRole("button", { name: /more/i }).click();
  await expect(page.locator(".portal-shell.is-nav-open .portal-sidebar")).toBeVisible();
  await expect(page.locator(".portal-sidebar").getByText("Activity")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/m3-admin-sheet.png` });
  await page.locator(".portal-sidebar").getByRole("link", { name: "Tenants" }).click();
  await expect(page.locator(".portal-shell.is-nav-open")).toHaveCount(0);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/m4-admin-tenants.png`, fullPage: true });
});
