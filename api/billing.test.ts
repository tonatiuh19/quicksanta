import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, canTransition, createServer, effectiveTenantPlan, participantLimit, planFromSubscriptionStatus, type BillingApi, type SubscriptionInfo } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const PRICING = { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd", pro_interval: "month" as const, grace_days: 3, save_offer_percent: 50 };
const SANTA = { id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "", description_es: "", icon: "gift", uses_draw: 1, is_active: 1, sort_order: 1 };
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));

const sub = (over: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  id: "sub_123456",
  status: "active",
  customer: "cus_123456",
  current_period_end: 1_800_000_000,
  cancel_at_period_end: false,
  client_secret: "pi_123_secret_abc",
  latest_invoice_id: "in_123456",
  card: { brand: "visa", last4: "4242", exp: "12/2034" },
  discount_percent: null,
  metadata: { tenant_id: "7" },
  ...over,
});

function fakeBilling(state: { sub?: SubscriptionInfo; failUpdate?: boolean } = {}) {
  const calls: string[] = [];
  let current = state.sub ?? sub({ status: "incomplete" });
  const api: BillingApi = {
    async createCustomer(o) {
      calls.push(`customer:${o.email}:${o.tenantId}`);
      return "cus_123456";
    },
    async createSubscription(o) {
      calls.push(`subscribe:${o.customer}:${o.price}:${o.idempotencyKey}`);
      current = sub({ status: "incomplete", customer: o.customer });
      return current;
    },
    async getSubscription(id) {
      calls.push(`get:${id}`);
      return current;
    },
    async updateSubscription(id, o) {
      calls.push(`update:${id}:${JSON.stringify(o)}`);
      if (state.failUpdate) throw new Error("stripe down");
      current = { ...current, cancel_at_period_end: o.cancel_at_period_end ?? current.cancel_at_period_end, discount_percent: o.coupon ? 50 : current.discount_percent };
      return current;
    },
    async cancelNow(id, reason) {
      calls.push(`cancelNow:${id}:${reason}`);
      current = { ...current, status: "canceled" };
      return current;
    },
    async createSetupIntent(customer) {
      calls.push(`setup:${customer}`);
      return { client_secret: "seti_123_secret" };
    },
    async setDefaultPaymentMethod(customer, pm) {
      calls.push(`default:${customer}:${pm}`);
      return { brand: "mastercard", last4: "4444", exp: "01/2030" };
    },
    async listInvoices() {
      return [{ id: "in_1", number: "QS-0001", status: "paid", amount_cents: 890, currency: "usd", created: 1_790_000_000, hosted_invoice_url: "https://inv", invoice_pdf: "https://pdf", subscription: "sub_123456", customer: "cus_123456", card: null }];
    },
    async getInvoice(id) {
      return { id, number: "QS-0002", status: "paid", amount_cents: 890, currency: "usd", created: 1, hosted_invoice_url: null, invoice_pdf: null, subscription: "sub_123456", customer: "cus_123456", card: null };
    },
    async payInvoice(id) {
      calls.push(`pay:${id}`);
      return "paid";
    },
    async ensureCoupon(p) {
      calls.push(`coupon:${p}`);
      return `qs-save-${p}`;
    },
    constructWebhookEvent(_raw, sig) {
      if (sig !== "good") throw new Error("bad sig");
      return { type: "customer.subscription.updated", data: { object: { id: "sub_123456" } } };
    },
  };
  __test.setBillingApi(api);
  return { calls, set: (s: SubscriptionInfo) => void (current = s) };
}

const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: 7, name: "Gomez Family", plan: "free", stripe_customer_id: null, stripe_subscription_id: null, subscription_status: "none", current_period_end: null,
  cancel_at_period_end: 0, cancel_reason: null, save_offer_used_at: null, card_brand: null, card_last4: null, card_exp: null, max_participants_per_event: 20, ...over,
});

beforeEach(() => {
  fake = installFakeDb();
  __test.setBillingApi(null);
  process.env.STRIPE_PLATFORM_PRICE_ID = "price_test_890";
});

describe("plan rules", () => {
  it("participantLimit: free 20, pro workspace 100, enterprise uses the tenant limit, legacy pro exchange 100", () => {
    expect(participantLimit(PRICING, "free", "free", 20)).toBe(20);
    expect(participantLimit(PRICING, "free", "pro", 20)).toBe(100);
    expect(participantLimit(PRICING, "pro", "free", 20)).toBe(100);
    expect(participantLimit(PRICING, "free", "enterprise", 500)).toBe(500);
  });
  it("subscription status → plan", () => {
    for (const s of ["active", "trialing", "past_due"]) expect(planFromSubscriptionStatus(s)).toBe("pro");
    for (const s of ["incomplete", "canceled", "unpaid", "incomplete_expired"]) expect(planFromSubscriptionStatus(s)).toBe("free");
  });
  it("past_due keeps Pro for grace_days after the FIRST failure (not the advanced period end), then drops to Free", () => {
    const at = (iso: string) => Date.parse(iso);
    const row = { plan: "pro", subscription_status: "past_due", current_period_end: "2027-01-01 00:00:00", past_due_since: "2026-12-01 00:00:00" };
    expect(effectiveTenantPlan(row, 3, at("2026-12-03T23:00:00Z"))).toBe("pro");
    expect(effectiveTenantPlan(row, 3, at("2026-12-04T01:00:00Z"))).toBe("free");
    const end = "2026-12-01 00:00:00";
    expect(effectiveTenantPlan({ plan: "pro", subscription_status: "active", current_period_end: end }, 3, at("2027-01-30T00:00:00Z"))).toBe("pro");
    expect(effectiveTenantPlan({ plan: "enterprise" }, 3)).toBe("enterprise");
  });
  it("canTransition blocks reopening and payment bypass", () => {
    expect(canTransition("pending_payment", "open", true)).toBe(false);
    expect(canTransition("drawn", "open", true)).toBe(false);
    expect(canTransition("open", "completed", false)).toBe(true);
  });
  it("GET /api/pricing exposes monthly Pro", async () => {
    expect((await request(app).get("/api/pricing")).body).toMatchObject({ pro_price_cents: 890, pro_interval: "month", free_max_participants: 20 });
  });
});

describe("wizard + plans", () => {
  const base = { eventTypeSlug: "secret_santa", name: "Big Party", currency: "USD", organizerName: "Org", includeMe: false, exclusions: [], sendInvites: true, allowWishlists: true };
  beforeEach(() => {
    fake.on(/FROM event_types WHERE slug = \?/, [SANTA]);
  });

  it("free workspace over 20 people → errors.needsPro", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, participants: people(21) });
    expect(r.body).toMatchObject({ error: "errors.needsPro", free_max: 20 });
  });

  it("Pro launch on a free workspace → pending_payment + queued invites", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, plan: "pro", participants: people(30) });
    expect(r.body).toMatchObject({ payment_required: true, invited: 0 });
    expect(fake.find(/INSERT INTO events/)!.params.slice(11, 14)).toEqual(["pending_payment", "free", 1]);
  });

  it("a workspace that already has Pro launches big exchanges right away (no payment)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT plan, subscription_status, current_period_end, past_due_since, max_events/, [{ plan: "pro", subscription_status: "active", current_period_end: "2099-01-01 00:00:00", max_events: 10, max_participants_per_event: 20, active: 0 }]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, participants: people(40) });
    expect(r.status).toBe(201);
    expect(r.body.payment_required).toBe(false);
    expect(fake.find(/INSERT INTO events/)!.params[11]).toBe("open");
  });

  it("past_due beyond grace counts as Free", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT plan, subscription_status, current_period_end, past_due_since, max_events/, [{ plan: "pro", subscription_status: "past_due", current_period_end: "2020-01-01 00:00:00", max_events: 10, max_participants_per_event: 20, active: 0 }]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, participants: people(25) });
    expect(r.body.error).toBe("errors.needsPro");
  });
});

describe("subscription billing", () => {
  beforeEach(() => {
    signIn(fake, { email: "org@example.com" }, [{ tenant_id: 7, role: "organizer", tenant_name: "Gomez Family" }]);
  });

  it("participants can't see or change billing", async () => {
    fake.reset();
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).get("/api/app/billing").set("Cookie", sessionCookie)).status).toBe(403);
    expect((await request(app).post("/api/app/billing/subscribe").set("Cookie", sessionCookie)).status).toBe(403);
  });

  it("503 when Stripe isn't configured", async () => {
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow()]);
    expect((await request(app).post("/api/app/billing/subscribe").set("Cookie", sessionCookie)).body.error).toBe("errors.paymentsUnavailable");
  });

  it("subscribe: creates customer once + subscription on the configured price, returns the invoice client secret", async () => {
    const b = fakeBilling();
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow()]);
    const r = await request(app).post("/api/app/billing/subscribe").set("Cookie", sessionCookie);
    expect(r.body).toMatchObject({ client_secret: "pi_123_secret_abc", subscription_id: "sub_123456" });
    expect(b.calls).toEqual(["customer:org@example.com:7", "subscribe:cus_123456:price_test_890:qs-sub-7-first"]); // deterministic key: double clicks dedupe at Stripe
    expect(fake.find(/UPDATE tenants SET stripe_customer_id = \? WHERE id = \? AND stripe_customer_id IS NULL/)).toBeTruthy();
  });

  it("subscribe again reuses the unfinished subscription; an active one → 409 alreadyPro", async () => {
    const b = fakeBilling({ sub: sub({ status: "incomplete" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "incomplete" })]);
    expect((await request(app).post("/api/app/billing/subscribe").set("Cookie", sessionCookie)).body.subscription_id).toBe("sub_123456");
    expect(b.calls.some((c) => c.startsWith("subscribe:"))).toBe(false);
    b.set(sub({ status: "active" }));
    expect((await request(app).post("/api/app/billing/subscribe").set("Cookie", sessionCookie)).body.error).toBe("errors.alreadyPro");
  });

  it("sync: active subscription → tenant Pro, card stored, pending exchanges opened with queued invites", async () => {
    fakeBilling({ sub: sub({ status: "active" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456" })]);
    fake.on(/SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "free", stripe_subscription_id: "sub_123456" }]);
    fake.on(/WHERE e.tenant_id = \? AND \(e.status = 'pending_payment'/, [{ id: 50, name: "Big", exchange_date: null, budget_min: null, budget_max: null, currency: "USD", invites_pending: 1, name_en: "Secret Santa", name_es: "Amigo", organizer: "Org" }]);
    fake.on(/status = 'invited' AND invite_token_hash IS NULL/, [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }]);
    const r = await request(app).post("/api/app/billing/sync").set("Cookie", sessionCookie);
    expect(r.body).toMatchObject({ status: "active", plan: "pro" });
    const upd = fake.find(/UPDATE tenants SET stripe_subscription_id = \?, subscription_status = \?/)!;
    expect(upd.params.slice(0, 2)).toEqual(["sub_123456", "active"]);
    expect(upd.params[3]).toBeNull(); // past_due_since cleared when healthy
    expect(upd.params[5]).toBe("pro");
    expect(upd.params.slice(6, 9)).toEqual(["visa", "4242", "12/2034"]);
    expect(fake.find(/UPDATE events SET status = 'open' WHERE id = \? AND tenant_id = \? AND status = 'pending_payment'/)).toBeTruthy();
    expect(__test.emailDryRuns.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("billing overview: effective plan, card, usage and invoices", async () => {
    fakeBilling();
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "active", current_period_end: "2099-01-01 00:00:00", card_brand: "visa", card_last4: "4242", card_exp: "12/2034" })]);
    fake.on(/COUNT\(\*\) AS events, COALESCE\(MAX/, [{ events: 2, largest: 35, pending: 0 }]);
    const r = await request(app).get("/api/app/billing").set("Cookie", sessionCookie);
    expect(r.body).toMatchObject({ plan: "pro", status: "active", card: { last4: "4242" }, usage: { largest: 35, limit: 100 }, save_offer_available: true });
    expect(r.body.invoices[0]).toMatchObject({ number: "QS-0001", amount_cents: 890 });
  });

  it("update card: SetupIntent, then default payment method on customer + subscription; past_due retries the open invoice", async () => {
    const b = fakeBilling({ sub: sub({ status: "past_due" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "past_due" })]);
    fake.on(/SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "pro", stripe_subscription_id: "sub_123456" }]);
    expect((await request(app).post("/api/app/billing/payment-method/setup").set("Cookie", sessionCookie)).body.client_secret).toBe("seti_123_secret");
    const r = await request(app).post("/api/app/billing/payment-method").set("Cookie", sessionCookie).send({ payment_method_id: "pm_card_mastercard" });
    expect(r.body).toMatchObject({ card: { last4: "4444" }, retried: "paid" });
    expect(b.calls).toEqual(expect.arrayContaining(["default:cus_123456:pm_card_mastercard", 'update:sub_123456:{"default_payment_method":"pm_card_mastercard"}', "pay:in_123456"]));
  });

  it("rejects malformed payment method ids", async () => {
    fakeBilling();
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ stripe_customer_id: "cus_123456" })]);
    expect((await request(app).post("/api/app/billing/payment-method").set("Cookie", sessionCookie).send({ payment_method_id: "nope" })).status).toBe(400);
  });

  it("cancel: requires the exact workspace name, schedules cancel at period end and stores the reason", async () => {
    const b = fakeBilling({ sub: sub({ status: "active" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "active" })]);
    const wrong = await request(app).post("/api/app/billing/cancel").set("Cookie", sessionCookie).send({ reason: "too_expensive", confirm_name: "gomez" });
    expect(wrong.body.error).toBe("errors.confirmNameMismatch");
    expect(b.calls.some((c) => c.startsWith("update:"))).toBe(false);
    const ok = await request(app).post("/api/app/billing/cancel").set("Cookie", sessionCookie).send({ reason: "too_expensive", feedback: "pricey", confirm_name: "  gomez   FAMILY " });
    expect(ok.status).toBe(200);
    expect(b.calls).toContain('update:sub_123456:{"cancel_at_period_end":true,"cancel_reason":"too_expensive"}');
    expect(fake.find(/UPDATE tenants SET cancel_reason = \?, cancel_feedback = \?/)!.params).toEqual(["too_expensive", "pricey", 7]);
  });

  it("cancel without a subscription → 409", async () => {
    fakeBilling();
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow()]);
    expect((await request(app).post("/api/app/billing/cancel").set("Cookie", sessionCookie).send({ reason: "other", confirm_name: "Gomez Family" })).body.error).toBe("errors.noSubscription");
  });

  it("cancelling while past_due ends it now and voids the unpaid invoice (no more retries)", async () => {
    const b = fakeBilling({ sub: sub({ status: "past_due" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "past_due" })]);
    const r = await request(app).post("/api/app/billing/cancel").set("Cookie", sessionCookie).send({ confirm_name: "Gomez Family" });
    expect(r.status).toBe(200);
    expect(b.calls).toContain("cancelNow:sub_123456:other"); // reason is optional
    expect(b.calls.some((c) => c.includes("cancel_at_period_end"))).toBe(false);
  });

  it("save offer is not offered while a payment is failing", async () => {
    fakeBilling({ sub: sub({ status: "past_due" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "past_due" })]);
    expect((await request(app).post("/api/app/billing/save-offer").set("Cookie", sessionCookie)).body.error).toBe("errors.noSubscription");
  });

  it("save offer is given back if Stripe fails", async () => {
    fakeBilling({ sub: sub({ status: "active" }), failUpdate: true });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "active" })]);
    expect((await request(app).post("/api/app/billing/save-offer").set("Cookie", sessionCookie)).status).toBe(500);
    expect(fake.find(/UPDATE tenants SET save_offer_used_at = NULL WHERE id = \?/)!.params).toEqual([7]);
  });

  it("save offer: once per workspace, applies the coupon and un-schedules cancellation", async () => {
    const b = fakeBilling({ sub: sub({ status: "active" }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "active" })]);
    const r = await request(app).post("/api/app/billing/save-offer").set("Cookie", sessionCookie);
    expect(r.body).toMatchObject({ percent: 50 });
    expect(b.calls).toEqual(expect.arrayContaining(["coupon:50", 'update:sub_123456:{"coupon":"qs-save-50","cancel_at_period_end":false}']));
    // Race / second use: the atomic claim fails.
    fake.on(/UPDATE tenants SET save_offer_used_at = UTC_TIMESTAMP\(\)/, { affectedRows: 0, insertId: 0 });
    expect((await request(app).post("/api/app/billing/save-offer").set("Cookie", sessionCookie)).body.error).toBe("errors.offerUsed");
  });

  it("resume: only when a cancellation is scheduled", async () => {
    const b = fakeBilling({ sub: sub({ status: "active", cancel_at_period_end: true }) });
    fake.on(/FROM tenants WHERE id = \?/, [tenantRow({ plan: "pro", stripe_customer_id: "cus_123456", stripe_subscription_id: "sub_123456", subscription_status: "active", cancel_at_period_end: 1 })]);
    expect((await request(app).post("/api/app/billing/resume").set("Cookie", sessionCookie)).status).toBe(200);
    expect(b.calls).toContain('update:sub_123456:{"cancel_at_period_end":false}');
  });
});

describe("Stripe webhook", () => {
  it("rejects bad signatures and syncs the workspace on subscription events", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    fakeBilling({ sub: sub({ status: "canceled" }) });
    fake.on(/SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "pro", stripe_subscription_id: "sub_123456" }]);
    const bad = await request(app).post("/api/webhooks/stripe").set("stripe-signature", "nope").set("Content-Type", "application/json").send("{}");
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/webhooks/stripe").set("stripe-signature", "good").set("Content-Type", "application/json").send('{"id":"evt"}');
    expect(ok.body).toEqual({ received: true });
    const upd = fake.find(/UPDATE tenants SET stripe_subscription_id = \?, subscription_status = \?/)!;
    expect(upd.params[1]).toBe("canceled");
    expect(upd.params[5]).toBe("free"); // lapsed → Free (exchanges keep running, growth locked)
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("ignores stale events for an old subscription of the same customer", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    fakeBilling({ sub: sub({ id: "sub_OLD", status: "canceled" }) });
    fake.on(/SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "pro", stripe_subscription_id: "sub_NEW" }]);
    await request(app).post("/api/webhooks/stripe").set("stripe-signature", "good").set("Content-Type", "application/json").send("{}");
    expect(fake.find(/UPDATE tenants SET stripe_subscription_id = \?/)).toBeUndefined();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});

describe("grace bookkeeping", () => {
  it("first past_due event stamps past_due_since; later ones keep it", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    fakeBilling({ sub: sub({ status: "past_due" }) });
    fake.on(/FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "pro", locale: "es", stripe_subscription_id: "sub_123456", subscription_status: "active", past_due_since: null }]);
    await request(app).post("/api/webhooks/stripe").set("stripe-signature", "good").set("Content-Type", "application/json").send("{}");
    const first = fake.find(/UPDATE tenants SET stripe_subscription_id = \?/)!;
    expect(first.params[3]).toMatch(/^\d{4}-\d{2}-\d{2} /);
    fake.reset();
    fakeBilling({ sub: sub({ status: "past_due" }) });
    fake.on(/FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "pro", locale: "es", stripe_subscription_id: "sub_123456", subscription_status: "past_due", past_due_since: "2026-11-01 00:00:00" }]);
    await request(app).post("/api/webhooks/stripe").set("stripe-signature", "good").set("Content-Type", "application/json").send("{}");
    expect(fake.find(/UPDATE tenants SET stripe_subscription_id = \?/)!.params[3]).toBe("2026-11-01 00:00:00");
    // Grace long gone → waiting exchanges are NOT opened.
    expect(fake.find(/e.status = 'pending_payment'/)).toBeUndefined();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
