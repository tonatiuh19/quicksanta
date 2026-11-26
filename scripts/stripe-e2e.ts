/**
 * Live end-to-end check of the Pro subscription against the RUNNING dev server + real Stripe TEST mode.
 *
 *   npm run dev                       # with STRIPE_WEBHOOK_SECRET from `stripe listen --print-secret`
 *   stripe listen --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed \
 *     --forward-to https://localhost:8080/api/webhooks/stripe --skip-verify
 *   npm run e2e:stripe
 *
 * Card entry is simulated server-side with Stripe test PaymentMethods (pm_card_visa, declined, 3DS…),
 * exactly what Stripe Elements produces in the browser. Fixtures: qsit-stripe-<ts>-…@example.com,
 * invites disabled (no real email), everything purged at the end. Refuses live keys.
 */
import "dotenv/config";
import crypto from "node:crypto";
import Stripe from "stripe";
import { cleanupByPrefix, createIntegrationTestPool, fixturePrefix } from "../api/testDbCleanup";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // local self-signed dev cert
const BASE = process.env.E2E_BASE_URL || "https://localhost:8080";
const SK = process.env.STRIPE_SECRET_KEY || "";
if (!SK.startsWith("sk_test_")) {
  console.error("❌ STRIPE_SECRET_KEY must be a TEST key (sk_test_…).");
  process.exit(1);
}
const stripe = new Stripe(SK);
const pool = createIntegrationTestPool();
const prefix = fixturePrefix("stripe");
const mail = (n: string) => `${prefix}${n}@example.com`;
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`);
  }
}
function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function makeUser(name: string, platformRole: "owner" | "admin" | null = null) {
  const email = mail(name);
  const [r] = (await pool.query("INSERT INTO users (public_id, email, full_name, platform_role) VALUES (?, ?, ?, ?)", [
    crypto.randomBytes(13).toString("hex").slice(0, 26).toUpperCase(),
    email,
    name,
    platformRole,
  ])) as any;
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [r.insertId, sha(token)]);
  return { id: Number(r.insertId), email, cookie: `qs_sid=${token}` };
}

async function call(cookie: string, method: string, path: string, body?: unknown, tenantId?: number) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, origin: BASE, ...(tenantId ? { "x-tenant-id": String(tenantId) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const people = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ name: `${tag}${i}`, email: mail(`${tag}${i}`) }));
const wizard = (over: Record<string, unknown>) => ({
  eventTypeSlug: "secret_santa",
  name: "E2E Pro Party",
  currency: "USD",
  organizerName: "Org",
  includeMe: true,
  exclusions: [],
  sendInvites: false,
  allowWishlists: true,
  ...over,
});

async function payWith(intentId: string, pm: string) {
  try {
    return await stripe.paymentIntents.confirm(intentId, { payment_method: pm, return_url: `${BASE}/app` });
  } catch (e: any) {
    return { status: "error", code: e?.code, decline_code: e?.raw?.decline_code } as any;
  }
}

const intentIdOf = (clientSecret: string) => clientSecret.split("_secret_")[0];

async function main() {
  console.log(`\n🧪 Stripe subscription E2E against ${BASE} (test mode)\n`);
  const org = await makeUser("org");
  const other = await makeUser("other");
  const admin = await makeUser("admin", "admin");
  let tenantId = 0;
  let proEventId = 0;
  let subId = "";
  let customerId = "";

  try {
    await step("pricing: free 20 / pro 100 / $8.90 per month", async () => {
      const r = await call("", "GET", "/api/pricing");
      expect(r.body.free_max_participants === 20 && r.body.pro_max_participants === 100 && r.body.pro_price_cents === 890 && r.body.pro_interval === "month", JSON.stringify(r.body));
    });

    await step("free exchange with 21 people is refused with errors.needsPro", async () => {
      const r = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ participants: people(20, "f") }));
      expect(r.status === 402 && r.body.error === "errors.needsPro", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("Pro launch (25 people) creates the exchange as pending_payment", async () => {
      const r = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ plan: "pro", participants: people(24, "p") }));
      expect(r.status === 201 && r.body.payment_required === true, `${r.status} ${JSON.stringify(r.body)}`);
      proEventId = r.body.event_id;
      tenantId = r.body.tenant_id;
    });

    await step("organizer can't open it without Pro (402 paymentRequired)", async () => {
      const r = await call(org.cookie, "PATCH", `/api/app/events/${proEventId}`, { status: "open" }, tenantId);
      expect(r.status === 402, `${r.status} ${JSON.stringify(r.body)}`);
    });

    let clientSecret = "";
    await step("subscribe creates a Stripe customer + subscription on STRIPE_PLATFORM_PRICE_ID ($8.90/month)", async () => {
      const r = await call(org.cookie, "POST", "/api/app/billing/subscribe", {}, tenantId);
      expect(r.status === 200 && r.body.client_secret, `${r.status} ${JSON.stringify(r.body)}`);
      clientSecret = r.body.client_secret;
      subId = r.body.subscription_id;
      const sub = await stripe.subscriptions.retrieve(subId);
      customerId = String(sub.customer);
      const price = sub.items.data[0].price;
      expect(price.id === process.env.STRIPE_PLATFORM_PRICE_ID && price.unit_amount === 890 && price.recurring?.interval === "month", JSON.stringify(price));
      expect(sub.metadata.tenant_id === String(tenantId), JSON.stringify(sub.metadata));
    });

    await step("subscribing twice reuses the unfinished subscription (no duplicates)", async () => {
      const r = await call(org.cookie, "POST", "/api/app/billing/subscribe", {}, tenantId);
      expect(r.body.subscription_id === subId, `${r.body.subscription_id} vs ${subId}`);
      const list = await stripe.subscriptions.list({ customer: customerId, status: "all" });
      expect(list.data.length === 1, `${list.data.length} subscriptions`);
    });

    await step("declined card → subscription stays incomplete, workspace stays Free, exchange stays closed", async () => {
      const pi = await payWith(intentIdOf(clientSecret), "pm_card_chargeDeclined");
      expect(pi.status === "error" && pi.code === "card_declined", JSON.stringify(pi));
      const r = await call(org.cookie, "POST", "/api/app/billing/sync", {}, tenantId);
      expect(r.body.status === "incomplete" && r.body.plan === "free", JSON.stringify(r.body));
      const d = await call(org.cookie, "GET", `/api/app/events/${proEventId}`, undefined, tenantId);
      expect(d.body.event.status === "pending_payment", d.body.event.status);
    });

    await step("another user can't read or start this workspace's billing", async () => {
      const r = await call(other.cookie, "GET", "/api/app/billing", undefined, tenantId);
      expect(r.status === 403, `${r.status}`);
      const s2 = await call(other.cookie, "POST", "/api/app/billing/subscribe", {}, tenantId);
      expect(s2.status === 403, `${s2.status}`);
    });

    await step("Visa payment → sync → workspace Pro, pending exchange opens", async () => {
      const pi = await payWith(intentIdOf(clientSecret), "pm_card_visa");
      expect(pi.status === "succeeded", JSON.stringify(pi));
      const r = await call(org.cookie, "POST", "/api/app/billing/sync", {}, tenantId);
      expect(r.body.status === "active" && r.body.plan === "pro", JSON.stringify(r.body));
      const d = await call(org.cookie, "GET", `/api/app/events/${proEventId}`, undefined, tenantId);
      expect(d.body.event.status === "open" && d.body.max_participants === 100, JSON.stringify({ s: d.body.event.status, m: d.body.max_participants }));
    });

    await step("subscribe again → 409 alreadyPro", async () => {
      const r = await call(org.cookie, "POST", "/api/app/billing/subscribe", {}, tenantId);
      expect(r.status === 409 && r.body.error === "errors.alreadyPro", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("billing overview: Pro active, renewal date, card visa 4242, paid invoice", async () => {
      const r = await call(org.cookie, "GET", "/api/app/billing", undefined, tenantId);
      expect(r.body.plan === "pro" && r.body.status === "active" && r.body.current_period_end, JSON.stringify(r.body));
      expect(r.body.card?.last4 === "4242" && r.body.card?.brand === "visa", JSON.stringify(r.body.card));
      expect(r.body.invoices.some((i: any) => i.status === "paid" && i.amount_cents === 890 && i.invoice_pdf), JSON.stringify(r.body.invoices));
    });

    await step("update payment method (SetupIntent + Mastercard) → default on subscription", async () => {
      const s = await call(org.cookie, "POST", "/api/app/billing/payment-method/setup", {}, tenantId);
      const si = await stripe.setupIntents.confirm(s.body.client_secret.split("_secret_")[0], { payment_method: "pm_card_mastercard" });
      expect(si.status === "succeeded", si.status);
      const r = await call(org.cookie, "POST", "/api/app/billing/payment-method", { payment_method_id: String(si.payment_method) }, tenantId);
      expect(r.status === 200 && r.body.card.brand === "mastercard" && r.body.card.last4 === "4444", JSON.stringify(r.body));
      const sub = await stripe.subscriptions.retrieve(subId);
      expect(String(sub.default_payment_method) === String(si.payment_method), `${sub.default_payment_method}`);
    });

    await step("Pro allows up to 100 people per exchange and refuses the 101st", async () => {
      const ok = await call(org.cookie, "POST", `/api/app/events/${proEventId}/participants`, { participants: people(75, "q"), send_invites: false }, tenantId);
      expect(ok.status === 201 && ok.body.added === 75, `${ok.status} ${JSON.stringify(ok.body)}`);
      const no = await call(org.cookie, "POST", `/api/app/events/${proEventId}/participants`, { participants: people(1, "z"), send_invites: false }, tenantId);
      expect(no.status === 402 && no.body.error === "errors.participantLimit", `${no.status} ${JSON.stringify(no.body)}`);
    });

    await step("cancel requires the workspace name, then schedules cancel at period end in Stripe", async () => {
      const bad = await call(org.cookie, "POST", "/api/app/billing/cancel", { reason: "too_expensive", confirm_name: "nope" }, tenantId);
      expect(bad.status === 400 && bad.body.error === "errors.confirmNameMismatch", JSON.stringify(bad.body));
      const name = (await call(org.cookie, "GET", "/api/auth/me")).body.user.memberships.find((m: any) => m.tenant_id === tenantId).tenant_name;
      const ok = await call(org.cookie, "POST", "/api/app/billing/cancel", { reason: "too_expensive", feedback: "e2e", confirm_name: name.toUpperCase() }, tenantId);
      expect(ok.status === 200, `${ok.status} ${JSON.stringify(ok.body)}`);
      expect((await stripe.subscriptions.retrieve(subId)).cancel_at_period_end === true, "Stripe not scheduled");
      const b = await call(org.cookie, "GET", "/api/app/billing", undefined, tenantId);
      expect(b.body.plan === "pro" && b.body.cancel_at_period_end === true, "Pro must stay until period end");
    });

    await step("resume un-schedules the cancellation", async () => {
      const r = await call(org.cookie, "POST", "/api/app/billing/resume", {}, tenantId);
      expect(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
      expect((await stripe.subscriptions.retrieve(subId)).cancel_at_period_end === false, "still scheduled");
    });

    await step("save offer applies a 50% once coupon, only once", async () => {
      const r = await call(org.cookie, "POST", "/api/app/billing/save-offer", {}, tenantId);
      expect(r.status === 200 && r.body.percent === 50, `${r.status} ${JSON.stringify(r.body)}`);
      const sub: any = await stripe.subscriptions.retrieve(subId, { expand: ["discounts.source.coupon"] });
      const d = sub.discounts?.[0];
      const pct = d?.coupon?.percent_off ?? d?.source?.coupon?.percent_off;
      expect(pct === 50, JSON.stringify(sub.discounts));
      const again = await call(org.cookie, "POST", "/api/app/billing/save-offer", {}, tenantId);
      expect(again.status === 409 && again.body.error === "errors.offerUsed", `${again.status}`);
    });

    await step("subscription ended in Stripe → webhook → workspace back to Free (exchanges keep running)", async () => {
      await stripe.subscriptions.cancel(subId);
      let status = "";
      for (let i = 0; i < 20 && status !== "canceled"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const [rows] = (await pool.query("SELECT subscription_status, plan FROM tenants WHERE id = ?", [tenantId])) as any;
        status = rows[0]?.subscription_status;
        if (status === "canceled") expect(rows[0].plan === "free", `plan ${rows[0].plan}`);
      }
      expect(status === "canceled", "webhook did not arrive within 20s — is `stripe listen` forwarding subscription events and STRIPE_WEBHOOK_SECRET set on the dev server?");
      const d = await call(org.cookie, "GET", `/api/app/events/${proEventId}`, undefined, tenantId);
      expect(d.body.event.status === "open" && d.body.max_participants === 20, JSON.stringify({ s: d.body.event.status, m: d.body.max_participants }));
    });

    await step("webhook rejects unsigned/forged calls", async () => {
      const r = await call("", "POST", "/api/webhooks/stripe", { type: "customer.subscription.updated", data: { object: { id: subId } } });
      expect(r.status === 400 && r.body.error === "errors.badSignature", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("Command Center: MRR KPI, tenant subscription filter, invoice payments; non-admin blocked", async () => {
      const o = await call(admin.cookie, "GET", "/api/admin/overview");
      expect(typeof o.body.kpis.mrr_cents === "number", JSON.stringify(o.body.kpis));
      const t = await call(admin.cookie, "GET", `/api/admin/tenants?subscription=canceled&q=${encodeURIComponent("Org")}`);
      expect(t.status === 200 && t.body.items.some((x: any) => x.id === tenantId && x.subscription_status === "canceled"), JSON.stringify(t.body).slice(0, 300));
      const p = await call(org.cookie, "GET", "/api/admin/payments");
      expect(p.status === 403, `non-admin got ${p.status}`);
    });
  } finally {
    if (customerId) await stripe.customers.del(customerId).catch(() => undefined); // test-mode cleanup
    await cleanupByPrefix(pool, prefix);
    await pool.end();
    console.log(`\n${failed ? "❌" : "🎉"} ${passed} passed, ${failed} failed. Fixtures purged (${prefix}*).\n`);
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
