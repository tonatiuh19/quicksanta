/**
 * Live end-to-end check of the Pro checkout against the RUNNING dev server + real Stripe TEST mode.
 *
 *   npm run dev                       # with STRIPE_WEBHOOK_SECRET from `stripe listen --print-secret`
 *   stripe listen --forward-to https://localhost:8080/api/webhooks/stripe --skip-verify
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

async function main() {
  console.log(`\n🧪 Stripe E2E against ${BASE} (test mode)\n`);
  const org = await makeUser("org");
  const other = await makeUser("other");
  const admin = await makeUser("admin", "admin");
  let tenantId = 0;
  let proEventId = 0;
  let intentId = "";

  try {
    await step("pricing endpoint: free 20 / pro 100 / $8.90", async () => {
      const r = await call("", "GET", "/api/pricing");
      expect(r.body.free_max_participants === 20 && r.body.pro_max_participants === 100 && r.body.pro_price_cents === 890, JSON.stringify(r.body));
    });

    await step("free exchange with 21 people is refused with errors.needsPro", async () => {
      const r = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ participants: people(20, "f") }));
      expect(r.status === 402 && r.body.error === "errors.needsPro", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("over 100 people is refused (Enterprise)", async () => {
      const r = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ plan: "pro", participants: people(101, "x") }));
      expect(r.status === 402 && r.body.error === "errors.participantLimit", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("Pro launch (25 people) creates the exchange as pending_payment", async () => {
      const r = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ plan: "pro", participants: people(24, "p") }));
      expect(r.status === 201 && r.body.payment_required === true, `${r.status} ${JSON.stringify(r.body)}`);
      proEventId = r.body.event_id;
      tenantId = r.body.tenant_id;
      const d = await call(org.cookie, "GET", `/api/app/events/${proEventId}`, undefined, tenantId);
      expect(d.body.event.status === "pending_payment" && d.body.event.plan === "free", JSON.stringify(d.body.event));
    });

    await step("organizer can't open it without paying (402 paymentRequired)", async () => {
      const r = await call(org.cookie, "PATCH", `/api/app/events/${proEventId}`, { status: "open" }, tenantId);
      expect(r.status === 402 && r.body.error === "errors.paymentRequired", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("checkout creates a real $8.90 USD PaymentIntent tagged with tenant + event", async () => {
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout`, {}, tenantId);
      expect(r.status === 200 && r.body.client_secret && r.body.amount_cents === 890, `${r.status} ${JSON.stringify(r.body)}`);
      intentId = r.body.payment_intent_id;
      const pi = await stripe.paymentIntents.retrieve(intentId);
      expect(pi.amount === 890 && pi.currency === "usd", `${pi.amount} ${pi.currency}`);
      expect(pi.metadata.event_id === String(proEventId) && pi.metadata.tenant_id === String(tenantId), JSON.stringify(pi.metadata));
    });

    await step("calling checkout again reuses the same intent (no double charge)", async () => {
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout`, {}, tenantId);
      expect(r.body.payment_intent_id === intentId, `${r.body.payment_intent_id} vs ${intentId}`);
    });

    await step("confirm before paying → 402 paymentNotCompleted", async () => {
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout/confirm`, { payment_intent_id: intentId }, tenantId);
      expect(r.status === 402 && r.body.error === "errors.paymentNotCompleted", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("declined card (pm_card_chargeDeclined) is rejected and nothing unlocks", async () => {
      const pi = await payWith(intentId, "pm_card_chargeDeclined");
      expect(pi.status === "error" && pi.code === "card_declined", JSON.stringify(pi));
      const d = await call(org.cookie, "GET", `/api/app/events/${proEventId}`, undefined, tenantId);
      expect(d.body.event.status === "pending_payment", d.body.event.status);
    });

    await step("insufficient funds card is rejected", async () => {
      const pi = await payWith(intentId, "pm_card_visa_chargeDeclinedInsufficientFunds");
      expect(pi.status === "error" && pi.decline_code === "insufficient_funds", JSON.stringify(pi));
    });

    await step("3-D Secure card leaves it requires_action → confirm still 402", async () => {
      const pi = await payWith(intentId, "pm_card_threeDSecure2Required");
      expect(pi.status === "requires_action", pi.status);
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout/confirm`, { payment_intent_id: intentId }, tenantId);
      expect(r.status === 402, `${r.status}`);
    });

    await step("another user can't confirm this exchange's payment (tenant isolation)", async () => {
      const r = await call(other.cookie, "POST", `/api/app/events/${proEventId}/checkout/confirm`, { payment_intent_id: intentId }, tenantId);
      expect(r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("successful Visa payment → confirm unlocks Pro and opens the exchange", async () => {
      // After a 3DS attempt Stripe needs a fresh intent; checkout hands one out.
      const c = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout`, {}, tenantId);
      intentId = c.body.payment_intent_id;
      const pi = await payWith(intentId, "pm_card_visa");
      expect(pi.status === "succeeded", JSON.stringify(pi));
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout/confirm`, { payment_intent_id: intentId }, tenantId);
      expect(r.status === 200 && r.body.event.plan === "pro" && r.body.event.status === "open" && r.body.event.paid_at, JSON.stringify(r.body));
      const [rows] = (await pool.query("SELECT status, card_brand, card_last4 FROM payments WHERE provider_payment_id = ?", [intentId])) as any;
      expect(rows[0]?.status === "succeeded" && rows[0]?.card_last4 === "4242" && rows[0]?.card_brand === "visa", JSON.stringify(rows[0]));
    });

    await step("confirm again is idempotent; checkout again → 409 alreadyPro", async () => {
      const r = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout/confirm`, { payment_intent_id: intentId }, tenantId);
      expect(r.status === 200, `${r.status}`);
      const c = await call(org.cookie, "POST", `/api/app/events/${proEventId}/checkout`, {}, tenantId);
      expect(c.status === 409 && c.body.error === "errors.alreadyPro", `${c.status} ${JSON.stringify(c.body)}`);
      const [n] = (await pool.query("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'event.paid' AND entity_id = ?", [String(proEventId)])) as any;
      expect(Number(n[0].c) === 1, `event.paid audited ${n[0].c} times`);
    });

    await step("Pro exchange now accepts up to 100 people, and refuses the 101st", async () => {
      const ok = await call(org.cookie, "POST", `/api/app/events/${proEventId}/participants`, { participants: people(75, "q"), send_invites: false }, tenantId);
      expect(ok.status === 201 && ok.body.added === 75, `${ok.status} ${JSON.stringify(ok.body)}`);
      const no = await call(org.cookie, "POST", `/api/app/events/${proEventId}/participants`, { participants: people(1, "z"), send_invites: false }, tenantId);
      expect(no.status === 402 && no.body.error === "errors.participantLimit", `${no.status} ${JSON.stringify(no.body)}`);
    });

    await step("upgrade a free exchange via webhook only (browser closed before confirm)", async () => {
      const w = await call(org.cookie, "POST", "/api/wizard/launch", wizard({ name: "E2E Free→Pro", participants: people(5, "w") }));
      expect(w.status === 201 && !w.body.payment_required, JSON.stringify(w.body));
      const eventId = w.body.event_id;
      const c = await call(org.cookie, "POST", `/api/app/events/${eventId}/checkout`, {}, tenantId);
      const pi = await payWith(c.body.payment_intent_id, "pm_card_mastercard");
      expect(pi.status === "succeeded", JSON.stringify(pi));
      let plan = "free";
      for (let i = 0; i < 20 && plan !== "pro"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        plan = (await call(org.cookie, "GET", `/api/app/events/${eventId}`, undefined, tenantId)).body.event?.plan;
      }
      expect(plan === "pro", "webhook did not unlock Pro within 20s — is `stripe listen` forwarding and STRIPE_WEBHOOK_SECRET set on the dev server?");
    });

    await step("webhook rejects unsigned/forged calls", async () => {
      const r = await call("", "POST", "/api/webhooks/stripe", { type: "payment_intent.succeeded", data: { object: { id: intentId } } });
      expect(r.status === 400 && r.body.error === "errors.badSignature", `${r.status} ${JSON.stringify(r.body)}`);
    });

    await step("Command Center payments grid: filter + search + revenue KPI", async () => {
      const g = await call(admin.cookie, "GET", `/api/admin/payments?status=succeeded&q=${encodeURIComponent("E2E")}&sort_by=amount&sort_dir=DESC`);
      expect(g.status === 200 && g.body.items.length >= 2 && g.body.items.every((p: any) => p.status === "succeeded"), `${g.status} ${JSON.stringify(g.body).slice(0, 300)}`);
      const o = await call(admin.cookie, "GET", "/api/admin/overview");
      expect(o.body.kpis.revenue_cents >= 1780, `revenue ${o.body.kpis.revenue_cents}`);
      const p = await call(org.cookie, "GET", "/api/admin/payments");
      expect(p.status === 403, `non-admin got ${p.status}`);
    });
  } finally {
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
