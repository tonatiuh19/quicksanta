/** Regression tests for the deep review + coverage for previously untested routes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer, type BillingApi } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
beforeEach(() => {
  fake = installFakeDb();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  __test.setBillingApi(null);
});

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", event_type_name_es: "Amigo secreto", name: "Office", description: null,
  status: "open", plan: "free", paid_at: null, budget_min: null, budget_max: null, currency: "USD", exchange_date: null, rsvp_deadline: null, location: null, allow_wishlists: 1,
  drawn_at: null, created_at: "", custom_name: null, match_mode: null, reveal_mode: "private", uses_draw: 1, participant_count: 20, joined_count: 2, max_participants_per_event: 20,
  tenant_plan_raw: "free", subscription_status: "none", current_period_end: null, past_due_since: null, ...over,
});
const EV_RE = /FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/;

describe("OTP brute force", () => {
  it("reserves the attempt atomically before comparing; a lost reservation is a lockout", async () => {
    fake.on(/FROM otp_codes WHERE email = \? AND consumed_at IS NULL/, [{ id: 9, code_hash: "x", attempts: 4 }]);
    fake.on(/UPDATE otp_codes SET attempts = attempts \+ 1 WHERE id = \? AND attempts < \?/, { affectedRows: 0, insertId: 0 });
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456" });
    expect(r.status).toBe(429);
    expect(fake.find(/UPDATE otp_codes SET attempts = attempts \+ 1/)!.params).toEqual([9, 5]);
  });
});

describe("suspended workspaces can still manage billing", () => {
  it("billing GET works (423 elsewhere)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer", tenant_status: "suspended" }]);
    fake.on(/FROM tenants WHERE id = \?/, [{ id: 7, name: "W", plan: "free", subscription_status: "none", max_participants_per_event: 20 }]);
    expect((await request(app).get("/api/app/billing").set("Cookie", sessionCookie)).status).toBe(200);
    expect((await request(app).get("/api/app/events").set("Cookie", sessionCookie)).status).toBe(423);
  });
});

describe("participant limits can't be bypassed", () => {
  it("re-inviting a removed person at the Free limit → needsPro", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(EV_RE, [eventRow()]);
    fake.on(/SELECT status FROM participants WHERE id = \?/, [{ status: "removed" }]);
    const r = await request(app).patch("/api/app/events/5/participants/3").set("Cookie", sessionCookie).send({ status: "invited" });
    expect(r.body.error).toBe("errors.needsPro");
  });

  it("a decliner re-accepting at the limit is refused", async () => {
    signIn(fake, { email: "ana@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [{ id: 4, tenant_id: 7, event_id: 5, email: "ana@example.com", status: "declined", event_status: "open", currency: "USD", tenant_status: "active" }]);
    fake.on(EV_RE, [eventRow()]);
    const r = await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true });
    expect(r.body.error).toBe("errors.participantLimit");
  });

  it("people left out of a draw can't join afterwards", async () => {
    signIn(fake, { email: "ana@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [{ id: 4, tenant_id: 7, event_id: 5, email: "ana@example.com", status: "invited", event_status: "drawn", currency: "USD", tenant_status: "active" }]);
    const r = await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true });
    expect(r.body.error).toBe("errors.alreadyDrawn");
  });
});

describe("queued invites", () => {
  it("a failed send drops the token again so the next sync retries it, and the flag stays set", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    __test.setEmailTransport(async () => {
      throw new Error("resend down");
    });
    const sub = { id: "sub_1", status: "active", customer: "cus_1", current_period_end: 1_900_000_000, cancel_at_period_end: false, client_secret: null, latest_invoice_id: null, card: null, discount_percent: null, metadata: {} };
    __test.setBillingApi({ getSubscription: async () => sub } as unknown as BillingApi);
    fake.on(/FROM tenants WHERE id = \?/, [{ id: 7, name: "W", plan: "free", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", subscription_status: "incomplete" }]);
    fake.on(/FROM tenants WHERE stripe_customer_id = \?/, [{ id: 7, plan: "free", locale: "en", stripe_subscription_id: "sub_1", subscription_status: "incomplete", past_due_since: null }]);
    fake.on(/AND \(e.status = 'pending_payment' OR/, [{ id: 50, name: "Big", exchange_date: null, budget_min: null, budget_max: null, currency: "USD", invites_pending: 1, custom_name: null, theme_rules: null, name_en: "Secret Santa", name_es: "Amigo", organizer: "Org" }]);
    fake.on(/status = 'invited' AND invite_token_hash IS NULL/, [{ id: 1, email: "a@example.com" }]);
    await request(app).post("/api/app/billing/sync").set("Cookie", sessionCookie);
    expect(fake.find(/UPDATE participants SET invite_token_hash = NULL/)).toBeTruthy();
    expect(fake.find(/UPDATE events SET invites_pending = 0/)).toBeUndefined();
    __test.setEmailTransport(null);
  });
});

describe("webhook", () => {
  it("objects missing in Stripe are acknowledged (no endless retries)", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    __test.setBillingApi({
      constructWebhookEvent: () => ({ type: "customer.subscription.updated", data: { object: { id: "sub_gone" } } }),
      getSubscription: async () => {
        throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
      },
    } as unknown as BillingApi);
    const r = await request(app).post("/api/webhooks/stripe").set("stripe-signature", "x").set("Content-Type", "application/json").send("{}");
    expect(r.body).toEqual({ received: true, ignored: true });
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});

describe("cron cleanup", () => {
  it("requires the bearer secret (timing-safe) and deletes old codes/sessions", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await request(app).get("/api/cron/cleanup")).status).toBe(401);
    expect((await request(app).get("/api/cron/cleanup").set("Authorization", "Bearer nope")).status).toBe(401);
    const ok = await request(app).get("/api/cron/cleanup").set("Authorization", "Bearer s3cret");
    expect(ok.body).toMatchObject({ ok: true });
    expect(fake.find(/DELETE FROM otp_codes/)).toBeTruthy();
    expect(fake.find(/DELETE FROM user_sessions/)).toBeTruthy();
  });
});

describe("previously untested routes", () => {
  it("PATCH /api/auth/profile updates name + locale for the signed-in user only", async () => {
    signIn(fake, { id: 3 });
    expect((await request(app).patch("/api/auth/profile").set("Cookie", sessionCookie).send({ full_name: "New", locale: "es" })).status).toBe(200);
    expect(fake.find(/UPDATE users SET full_name = \? WHERE id = \?/)!.params).toEqual(["New", 3]);
    expect(fake.find(/UPDATE users SET locale = \? WHERE id = \?/)!.params).toEqual(["es", 3]);
    expect((await request(app).patch("/api/auth/profile").set("Cookie", sessionCookie).send({ locale: "fr" })).status).toBe(400);
  });

  it("DELETE exclusion is tenant + event scoped", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/DELETE FROM exclusions/, { affectedRows: 0, insertId: 0 });
    expect((await request(app).delete("/api/app/events/5/exclusions/9").set("Cookie", sessionCookie)).status).toBe(404);
    expect(fake.find(/DELETE FROM exclusions/)!.params).toEqual([9, 5, 7]);
  });

  it("reset-draw: only drawn exchanges, guarded inside the transaction", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(EV_RE, [eventRow({ status: "drawn" })]);
    fake.on(/UPDATE events SET status = 'open', drawn_at = NULL/, { affectedRows: 0, insertId: 0 }); // completed by a racing request
    expect((await request(app).post("/api/app/events/5/reset-draw").set("Cookie", sessionCookie)).body.error).toBe("errors.notDrawn");
    expect(fake.find(/DELETE FROM assignments/)).toBeUndefined();
  });

  it("members: grid is tenant scoped; can't change yourself; last organizer is protected", async () => {
    signIn(fake, { id: 1 }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT COUNT\(\*\) AS c FROM tenant_members m/, [{ c: 1 }]);
    expect((await request(app).get("/api/app/members").set("Cookie", sessionCookie)).body.pagination.total).toBe(1);
    expect(fake.find(/FROM tenant_members m JOIN users u .* LIMIT/)!.params[0]).toBe(7);
    fake.on(/SELECT user_id, role FROM tenant_members WHERE id = \?/, [{ user_id: 1, role: "organizer" }]);
    expect((await request(app).patch("/api/app/members/3").set("Cookie", sessionCookie).send({ role: "participant" })).body.error).toBe("errors.cannotChangeSelf");
    fake.reset();
    signIn(fake, { id: 1 }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT user_id, role FROM tenant_members WHERE id = \?/, [{ user_id: 2, role: "organizer" }]);
    fake.on(/role = 'organizer' AND status = 'active'/, [{ c: 1 }]);
    expect((await request(app).patch("/api/app/members/3").set("Cookie", sessionCookie).send({ remove: true })).body.error).toBe("errors.lastOrganizer");
  });

  it("PATCH /api/app/tenant renames the active workspace only", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    await request(app).patch("/api/app/tenant").set("Cookie", sessionCookie).send({ name: "Gomez Clan", slug: "hijack" });
    expect(fake.find(/UPDATE tenants SET name = \? WHERE id = \?/)!.params).toEqual(["Gomez Clan", 7]);
    expect(fake.find(/UPDATE tenants SET .*slug/)).toBeUndefined();
  });

  it("admin events / audit / emails grids: whitelisted filters, admin only", async () => {
    signIn(fake, { platform_role: "admin" });
    for (const [path, filter] of [["/api/admin/events", "status=pending_payment"], ["/api/admin/audit", "entity=tenant"], ["/api/admin/emails", "status=failed"]]) {
      const r = await request(app).get(`${path}?${filter}&sort_by=bogus&q=x`).set("Cookie", sessionCookie);
      expect(r.status).toBe(200);
    }
    expect(fake.find(/e.status = \?/)!.params).toContain("pending_payment");
    fake.reset();
    signIn(fake, { platform_role: null });
    expect((await request(app).get("/api/admin/emails").set("Cookie", sessionCookie)).status).toBe(403);
  });

  it("budgets above the DECIMAL range are a 400, not a 500", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(EV_RE, [eventRow()]);
    expect((await request(app).patch("/api/app/events/5").set("Cookie", sessionCookie).send({ budget_max: 1e12 })).status).toBe(400);
  });
});
