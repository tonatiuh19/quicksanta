/**
 * Mobile visual audit: screenshots every screen at the phone width of the project (iPhone 13 = 390, plus 320 via MOBILE_W)
 * and fails on any horizontal overflow. Run: npx playwright test e2e/mobile-audit.spec.ts --project mobile
 */
import { expect, test, type Page } from "@playwright/test";
import { cleanup, mail, makeUser, pool, SHOTS, signInAs } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await cleanup();
});

const W = Number(process.env.MOBILE_W || 0);
async function shot(page: Page, name: string) {
  if (W) await page.setViewportSize({ width: W, height: 740 });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await expect(page.locator(".qs-inline-spinner, .portal-shell-loading, .qs-spinner")).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > doc.clientWidth + 1 && getComputedStyle(el).position !== "fixed" && r.width > 0 && !el.closest(".table-scroll, .qs-template-row, .qs-tabs, .qs-choice-grid > *, [aria-hidden=true]");
      })
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`);
    return { scroll: doc.scrollWidth - doc.clientWidth, wide };
  });
  await page.screenshot({ path: `${SHOTS}/m-${W || 390}-${name}.png`, fullPage: true });
  expect.soft(overflow.scroll, `${name}: page scrolls sideways; widest: ${overflow.wide.join(" | ")}`).toBeLessThanOrEqual(1);
  if (overflow.wide.length) console.log(`[${name}] elements past the edge: ${overflow.wide.join(" | ")}`);
}

let org: Awaited<ReturnType<typeof makeUser>>;
let eventId = 0;
let publicId = "";

test("public screens", async ({ page }) => {
  await page.goto("/");
  await shot(page, "01-landing");
  await page.goto("/login");
  await shot(page, "02-login");
  await page.goto("/terms");
  await shot(page, "03-terms");
  await page.goto("/join");
  await shot(page, "04-join-code");
  await page.goto("/j/ZZZZ-ZZZZ");
  await shot(page, "05-join-code-unknown");
  await page.goto("/#contact");
  await shot(page, "06-contact-sales");
});

test("wizard every step", async ({ page, context }) => {
  org = await makeUser("mobileorg");
  await signInAs(context, org);
  await page.goto("/start");
  await shot(page, "10-wizard-service");
  await page.getByRole("radio", { name: /create your own/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/exchange style name/i).fill("Ugly Sweater Swap");
  await shot(page, "11-wizard-design");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/exchange name/i).fill("Office Christmas Party 2026");
  await shot(page, "12-wizard-details");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /paste a list/i }).click();
  await page.getByRole("textbox", { name: /paste a list/i }).fill(Array.from({ length: 5 }, (_, i) => `Person Number ${i} <${mail(`verylongemailaddress${i}`)}>`).join("\n"));
  await page.getByRole("button", { name: /add all/i }).click();
  await shot(page, "13-wizard-people");
  await page.getByRole("button", { name: /continue/i }).click();
  await shot(page, "14-wizard-rules");
  await page.getByRole("button", { name: /continue/i }).click();
  await shot(page, "15-wizard-review");
  await page.getByText("Email invitations now").click();
  await page.locator(".qs-btn-launch").click();
  await expect(page.getByText("Unlock Pro for your workspace")).toBeVisible({ timeout: 30_000 });
  await shot(page, "16-wizard-pay");
});

test("workspace screens", async ({ page, context }) => {
  await signInAs(context, org);
  // A Free Secret Santa exchange to look at.
  let [tn] = (await pool.query("SELECT t.id FROM tenants t JOIN tenant_members m ON m.tenant_id = t.id WHERE m.user_id = ? LIMIT 1", [org.id])) as any;
  if (!tn[0]) {
    const [t] = (await pool.query("INSERT INTO tenants (public_id, name, slug, created_by) VALUES (?, 'Mobile Org exchanges', ?, ?)", [`MOBT${Date.now()}`, `mob-${Date.now()}`, org.id])) as any;
    await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'organizer')", [t.insertId, org.id]);
    tn = [{ id: t.insertId }];
  }
  const tid = tn[0].id;

  const [ev] = (await pool.query("INSERT INTO events (public_id, tenant_id, event_type_id, name, status, budget_min, budget_max, currency, exchange_date, location) VALUES (?, ?, 1, 'Family Christmas with a very long name 2026', 'open', 20, 50, 'USD', '2026-12-24', 'Grandma house, Monterrey')", [`MOB${Date.now()}`.slice(0, 26), tid])) as any;
  eventId = ev.insertId;
  for (let i = 0; i < 6; i++) {
    await pool.query("INSERT INTO participants (public_id, tenant_id, event_id, name, email, status) VALUES (?, ?, ?, ?, ?, ?)", [`MOBP${Date.now()}${i}`.slice(0, 26), tid, eventId, `Participant ${i} Longname`, mail(`p${i}withaverylongaddress`), i % 2 ? "joined" : "invited"]);
  }
  await page.goto("/app");
  await shot(page, "20-dashboard");
  await page.goto("/app/events");
  await shot(page, "21-events");
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(`/app/events/${eventId}`);
  await shot(page, "22-event-detail");
  await page.getByRole("tab", { name: /rules/i }).click();
  await shot(page, "23-event-rules");
  await page.goto("/app/members");
  await shot(page, "24-members");
  await page.goto("/app/billing");
  await shot(page, "25-billing");
  await page.getByRole("button", { name: /upgrade to pro/i }).first().click();
  await shot(page, "26-billing-upgrade-modal");
  await page.keyboard.press("Escape");
  await page.goto("/app/profile");
  await shot(page, "27-profile");
  await page.getByRole("button", { name: /more/i }).click();
  await shot(page, "28-more-sheet");
});

test("participant + join + admin", async ({ page, context }) => {
  const [e] = (await pool.query("SELECT public_id, tenant_id FROM events WHERE id = ?", [eventId])) as any;
  publicId = e[0].public_id;
  await pool.query("UPDATE participants SET user_id = ?, status = 'joined' WHERE event_id = ? ORDER BY id LIMIT 1", [org.id, eventId]);
  await signInAs(context, org);
  await page.goto("/app/my");
  await shot(page, "30-my-exchanges");
  await page.goto(`/app/my/${publicId}`);
  await shot(page, "31-my-assignment");
  const admin = await makeUser("mobileadmin", "owner");
  await context.clearCookies();
  await signInAs(context, admin);
  await page.goto("/admin");
  await shot(page, "40-admin-overview");
  await page.goto("/admin/tenants");
  await shot(page, "41-admin-tenants");
  await page.goto("/admin/payments");
  await shot(page, "42-admin-payments");
  await page.goto("/admin/catalog");
  await shot(page, "43-admin-catalog");
  await page.goto("/admin/leads");
  await shot(page, "44-admin-leads");
  await page.goto("/admin/email-gallery");
  await shot(page, "45-admin-email-gallery");
  await context.clearCookies();
  await page.goto("/join/invalidtokeninvalidtoken");
  await shot(page, "50-join-invalid");
});
