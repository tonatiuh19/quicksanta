import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, canTransition, createServer, participantLimit, type PaymentsApi } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const PRICING = { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd" };
const SANTA = { id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "", description_es: "", icon: "gift", uses_draw: 1, is_active: 1, sort_order: 1 };
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", description: null,
  status: "open", plan: "free", paid_at: null, budget_min: null, budget_max: null, currency: "USD", exchange_date: null, rsvp_deadline: null, location: null,
  allow_wishlists: 1, drawn_at: null, created_at: "", participant_count: 3, joined_count: 2, uses_draw: 1, max_participants_per_event: 20, tenant_plan: "free", ...over,
});

function fakePayments(status = "succeeded", metadata = { event_id: "5", tenant_id: "7" }) {
  const calls: string[] = [];
  const api: PaymentsApi = {
    async createIntent(o) {
      calls.push(`create:${o.amount}:${o.currency}:${o.metadata.event_id}`);
      return { id: "pi_test_123456", client_secret: "pi_test_123456_secret_x", status: "requires_payment_method" };
    },
    async retrieveIntent(id) {
      calls.push(`retrieve:${id}`);
      return { id, status, amount: 890, currency: "usd", metadata, card_brand: "visa", card_last4: "4242", client_secret: "pi_test_123456_secret_x" };
    },
    constructWebhookEvent(_raw, sig) {
      if (sig !== "good") throw new Error("bad sig");
      return { type: "payment_intent.succeeded", data: { object: { id: "pi_test_123456" } } };
    },
  };
  __test.setPaymentsApi(api);
  return calls;
}

beforeEach(() => {
  fake = installFakeDb();
  __test.setPaymentsApi(null);
});

describe("pricing rules", () => {
  it("participantLimit: free 20, pro 100, enterprise uses the tenant limit", () => {
    expect(participantLimit(PRICING, "free", "free", 20)).toBe(20);
    expect(participantLimit(PRICING, "pro", "free", 20)).toBe(100);
    expect(participantLimit(PRICING, "free", "enterprise", 500)).toBe(500);
  });
  it("canTransition blocks reopening and payment bypass", () => {
    expect(canTransition("pending_payment", "open", true)).toBe(false);
    expect(canTransition("pending_payment", "cancelled", true)).toBe(true);
    expect(canTransition("drawn", "open", true)).toBe(false);
    expect(canTransition("cancelled", "open", true)).toBe(false);
    expect(canTransition("open", "completed", true)).toBe(false);
    expect(canTransition("open", "completed", false)).toBe(true);
    expect(canTransition("drawn", "completed", true)).toBe(true);
  });
  it("GET /api/pricing", async () => {
    expect((await request(app).get("/api/pricing")).body).toMatchObject(PRICING);
  });
});

describe("wizard + plans", () => {
  const base = { eventTypeSlug: "secret_santa", name: "Big Party", currency: "USD", organizerName: "Org", includeMe: false, exclusions: [], sendInvites: true, allowWishlists: true };
  beforeEach(() => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [SANTA]);
  });

  it("free exchange over 20 people → errors.needsPro (nothing written)", async () => {
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, participants: people(21) });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "errors.needsPro", free_max: 20, pro_max: 100 });
    expect(fake.find(/INSERT INTO events/)).toBeUndefined();
  });

  it("pro exchange is created pending payment, invites are queued (not sent)", async () => {
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, plan: "pro", participants: people(30) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ payment_required: true, invited: 0 });
    const ev = fake.find(/INSERT INTO events/)!;
    expect(ev.params.slice(5, 8)).toEqual(["pending_payment", "free", 1]);
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it("over 100 people → errors.participantLimit (Enterprise)", async () => {
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, plan: "pro", participants: people(101) });
    expect(r.body.error).toBe("errors.participantLimit");
  });
});

describe("checkout", () => {
  beforeEach(() => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow({ status: "pending_payment" })]);
  });

  it("503 when Stripe is not configured", async () => {
    expect((await request(app).post("/api/app/events/5/checkout").set("Cookie", sessionCookie)).body.error).toBe("errors.paymentsUnavailable");
  });

  it("creates a $8.90 intent tagged with tenant + event and records a pending payment", async () => {
    const calls = fakePayments();
    const r = await request(app).post("/api/app/events/5/checkout").set("Cookie", sessionCookie);
    expect(r.body).toMatchObject({ client_secret: "pi_test_123456_secret_x", amount_cents: 890, currency: "usd" });
    expect(calls).toEqual(["create:890:usd:5"]);
    expect(fake.find(/INSERT INTO payments/)!.params).toEqual([7, 5, 1, "pi_test_123456", 890, "USD"]);
  });

  it("reuses an open intent instead of creating a second one", async () => {
    const calls = fakePayments("requires_payment_method");
    fake.on(/SELECT provider_payment_id FROM payments/, [{ provider_payment_id: "pi_test_123456" }]);
    await request(app).post("/api/app/events/5/checkout").set("Cookie", sessionCookie);
    expect(calls).toEqual(["retrieve:pi_test_123456"]);
    expect(fake.find(/INSERT INTO payments/)).toBeUndefined();
  });

  it("confirm: succeeded → Pro + opened + queued invites sent; idempotent guard on paid_at", async () => {
    fakePayments("succeeded");
    fake.on(/SELECT id FROM payments WHERE provider_payment_id = \?/, [{ id: 1 }]);
    fake.on(/SELECT e.name, e.exchange_date/, [{ name: "Office", exchange_date: null, budget_min: null, budget_max: null, currency: "USD", invites_pending: 1, name_en: "Secret Santa", name_es: "Amigo", organizer: "Org" }]);
    fake.on(/status = 'invited' AND invite_token_hash IS NULL/, [{ id: 11, email: "a@example.com" }, { id: 12, email: "b@example.com" }]);
    const r = await request(app).post("/api/app/events/5/checkout/confirm").set("Cookie", sessionCookie).send({ payment_intent_id: "pi_test_123456" });
    expect(r.status).toBe(200);
    const upd = fake.find(/UPDATE events SET plan = 'pro'/)!;
    expect(upd.sql).toContain("paid_at IS NULL");
    expect(upd.sql).toContain("IF(status = 'pending_payment', 'open', status)");
    expect(__test.emailDryRuns.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("confirm rejects intents for another event / unfinished payments / unknown intents", async () => {
    fake.on(/SELECT id FROM payments WHERE provider_payment_id = \?/, [{ id: 1 }]);
    fakePayments("succeeded", { event_id: "999", tenant_id: "7" });
    expect((await request(app).post("/api/app/events/5/checkout/confirm").set("Cookie", sessionCookie).send({ payment_intent_id: "pi_test_123456" })).body.error).toBe("errors.paymentMismatch");
    fakePayments("requires_payment_method");
    expect((await request(app).post("/api/app/events/5/checkout/confirm").set("Cookie", sessionCookie).send({ payment_intent_id: "pi_test_123456" })).body.error).toBe("errors.paymentNotCompleted");
  });

  it("organizers can't open a pending exchange without paying", async () => {
    const r = await request(app).patch("/api/app/events/5").set("Cookie", sessionCookie).send({ status: "open" });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("errors.paymentRequired");
  });
});

describe("Stripe webhook", () => {
  it("rejects bad signatures and finalizes on payment_intent.succeeded", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    fakePayments("succeeded");
    const bad = await request(app).post("/api/webhooks/stripe").set("stripe-signature", "nope").set("Content-Type", "application/json").send("{}");
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/webhooks/stripe").set("stripe-signature", "good").set("Content-Type", "application/json").send('{"id":"evt"}');
    expect(ok.body).toEqual({ received: true });
    expect(fake.find(/UPDATE events SET plan = 'pro'/)).toBeTruthy();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
