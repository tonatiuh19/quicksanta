import "dotenv/config";
import crypto from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { cleanupByPrefix, createIntegrationTestPool, fixturePrefix } from "../api/testDbCleanup";

export const pool = createIntegrationTestPool();
export const prefix = fixturePrefix(`pw${process.pid}`);
export const mail = (n: string) => `${prefix}${n}@example.com`;
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
export const SHOTS = process.env.E2E_SHOTS || "test-results/shots";

export async function makeUser(name: string, platformRole: "owner" | "admin" | null = null) {
  const email = mail(name);
  const [r] = (await pool.query("INSERT INTO users (public_id, email, full_name, platform_role) VALUES (?, ?, ?, ?)", [
    crypto.randomBytes(13).toString("hex").slice(0, 26).toUpperCase(),
    email,
    name,
    platformRole,
  ])) as any;
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [r.insertId, sha(token)]);
  return { id: Number(r.insertId), email, name, token };
}

export async function signInAs(ctx: BrowserContext, u: { token: string }) {
  await ctx.addCookies([{ name: "qs_sid", value: u.token, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
}

/** The latest OTP for an email is hashed; set it to a known code so the UI flow can be typed. */
export async function forceOtp(email: string, code = "424242") {
  await expect.poll(async () => {
    const [rows] = (await pool.query("SELECT id FROM otp_codes WHERE email = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1", [email])) as any;
    if (!rows[0]) return false;
    await pool.query("UPDATE otp_codes SET code_hash = ? WHERE id = ?", [sha(code), rows[0].id]);
    return true;
  }).toBe(true);
  return code;
}

/** Fill Stripe's card iframes (number / expiry / CVC). */
export async function fillCard(page: Page, number: string) {
  const frames = page.frameLocator(".qs-card-field__input iframe");
  await page.frameLocator(".qs-card-field__input iframe").first().locator('input[name="cardnumber"]').fill(number);
  await page.locator(".qs-card-field__input iframe").nth(1).contentFrame().locator('input[name="exp-date"]').fill("12 / 34");
  await page.locator(".qs-card-field__input iframe").nth(2).contentFrame().locator('input[name="cvc"]').fill("123");
  void frames;
}

/** Complete (or fail) Stripe's 3-D Secure test challenge. */
export async function answer3ds(page: Page, action: "complete" | "fail") {
  const text = action === "complete" ? "COMPLETE" : "FAIL";
  const acs = () => page.frames().find((f) => f.url().includes("3d_secure_2_test"));
  await expect.poll(() => Boolean(acs()), { timeout: 30_000 }).toBe(true);
  // The test ACS page ignores clicks until it has finished loading: click until the challenge closes.
  await expect
    .poll(
      async () => {
        const f = acs();
        if (!f) return "closed";
        const btn = f.locator("button", { hasText: new RegExp(`^\\s*${text}\\s*$`, "i") });
        await btn.first().click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        return acs() ? "open" : "closed";
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBe("closed");
}

export async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page scrolls horizontally").toBeLessThanOrEqual(1);
}

export async function cleanup() {
  // Test-mode Stripe customers created by these fixtures (cancels their subscriptions too).
  const [rows] = (await pool.query("SELECT t.stripe_customer_id FROM tenants t JOIN users u ON u.id = t.created_by WHERE u.email LIKE ? AND t.stripe_customer_id IS NOT NULL", [`${prefix}%`])) as any;
  const sk = process.env.STRIPE_SECRET_KEY || "";
  if (sk.startsWith("sk_test_")) {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(sk);
    for (const r of rows) await stripe.customers.del(r.stripe_customer_id).catch(() => undefined);
  }
  await cleanupByPrefix(pool, prefix);
}
