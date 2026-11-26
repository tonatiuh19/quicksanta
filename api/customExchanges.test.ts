import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer, tplAssignment, tplInvite } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const type = (slug: string, over: Record<string, unknown> = {}) => ({ id: 9, slug, name_en: slug, name_es: slug, description_en: "", description_es: "", icon: "gift", uses_draw: 1, requires_pro: 0, is_active: 1, sort_order: 1, ...over });
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
const base = { name: "Sweater Party", currency: "USD", organizerName: "Org", includeMe: false, exclusions: [], sendInvites: true, allowWishlists: true };
const design = { name: "Ugly Sweater Swap", icon: "snowflake", color: "green", matchMode: "none", themeRules: "Must be <b>knitted</b>", revealMode: "private" };
const proWs = () => fake.on(/SELECT plan, subscription_status, current_period_end, past_due_since, max_events/, [{ plan: "pro", subscription_status: "active", current_period_end: "2099-01-01 00:00:00", max_events: 10, max_participants_per_event: 20, active: 0 }]);
const insertEvent = () => fake.find(/INSERT INTO events/)!;

beforeEach(() => {
  fake = installFakeDb();
});

describe("Pro-only services", () => {
  it("a Pro-only service on a Free (new) workspace is created pending_payment — no invites until subscribed", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("book_swap", { requires_pro: 1 })]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "book_swap", participants: people(4) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ payment_required: true, invited: 0 });
    expect(insertEvent().params[11]).toBe("pending_payment");
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it("free services stay free", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("secret_santa")]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "secret_santa", participants: people(4) });
    expect(r.body.payment_required).toBe(false);
    expect(insertEvent().params[11]).toBe("open");
  });

  it("Pro workspaces launch Pro-only services right away", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    proWs();
    fake.on(/FROM event_types WHERE slug = \?/, [type("cookie_swap", { requires_pro: 1, uses_draw: 0 })]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "cookie_swap", participants: people(2) });
    expect(r.body.payment_required).toBe(false);
  });
});

describe("Create your own", () => {
  beforeEach(() => {
    fake.on(/FROM event_types WHERE slug = \?/, [type("custom", { requires_pro: 1, icon: "sparkles" })]);
  });

  it("requires a design", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "custom", participants: people(3) });
    expect(r.body.error).toBe("validation.customDesign");
  });

  it("rejects unknown icons/colors", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "custom", custom: { ...design, icon: "skull" }, participants: people(3) });
    expect(r.body.error).toBe("validation.invalid");
  });

  it("'reveal together' needs an exchange date", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "custom", custom: { ...design, matchMode: "draw", revealMode: "together" }, participants: people(3) });
    expect(r.body.error).toBe("validation.revealNeedsDate");
  });

  it("no-draw design needs only 1 person and stores the design on the exchange; template saved on request", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    proWs();
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send({ ...base, eventTypeSlug: "custom", custom: design, saveTemplate: true, participants: people(1), budgetMin: 10, budgetMax: 20 });
    expect(r.status).toBe(201);
    const p = insertEvent().params;
    expect(p.slice(3, 10)).toEqual(["Sweater Party", "Ugly Sweater Swap", "snowflake", "green", "none", "Must be <b>knitted</b>", "private"]);
    const tpl = fake.find(/INSERT INTO event_templates/)!;
    expect(tpl.params.slice(0, 6)).toEqual([7, 1, "Ugly Sweater Swap", "snowflake", "green", "none"]);
    expect(tpl.sql).toContain("ON DUPLICATE KEY UPDATE");
  });

  it("draw design runs the exclusion check like Secret Santa", async () => {
    signIn(fake);
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send({ ...base, eventTypeSlug: "custom", custom: { ...design, matchMode: "draw" }, participants: people(2) });
    expect(r.body).toMatchObject({ error: "validation.minParticipants", min: 3 });
  });

  it("custom payload is ignored for catalog services", async () => {
    signIn(fake);
    fake.reset();
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("secret_santa")]);
    await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "secret_santa", custom: design, saveTemplate: true, participants: people(3) });
    expect(insertEvent().params[4]).toBeNull();
    expect(fake.find(/INSERT INTO event_templates/)).toBeUndefined();
  });

  it("invite emails escape the theme rules and use the custom name", () => {
    const t = tplInvite("en", { organizer: "Org", eventName: "Party", typeName: "Ugly Sweater Swap", date: null, budget: null, themeRules: "Must be <b>knitted</b>", link: "https://x/join/a" });
    expect(t.html).toContain("Ugly Sweater Swap");
    expect(t.html).toContain("&lt;b&gt;knitted&lt;/b&gt;");
    expect(t.html).not.toContain("<b>knitted</b>");
  });
});

describe("reveal together", () => {
  const row = (over: Record<string, unknown>) => ({
    id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "custom", event_type_name: "Create your own", name: "X", description: null, status: "drawn", plan: "free", paid_at: null,
    budget_min: null, budget_max: null, currency: "USD", exchange_date: "2099-12-24", rsvp_deadline: null, location: null, allow_wishlists: 1, drawn_at: null, created_at: "",
    custom_name: "Ugly Sweater Swap", custom_icon: "snowflake", custom_color: "green", match_mode: "draw", theme_rules: null, reveal_mode: "together", requires_pro: 1, uses_draw: 1,
    participant_count: 3, joined_count: 3, me_id: 11, me_name: "Me", me_wishlist: null, me_status: "joined", ...over,
  });

  it("hides the match until the exchange day and says when", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/FROM participants me JOIN events e .* WHERE e.public_id = \?/, [row({})]);
    const r = await request(app).get("/api/app/my/events/EVT").set("Cookie", sessionCookie);
    expect(r.body.receiver).toBeNull();
    expect(r.body.reveal_at).toBe("2099-12-24");
    expect(fake.find(/FROM assignments a/)).toBeUndefined();
    expect(r.body.event.custom).toEqual({ name: "Ugly Sweater Swap", icon: "snowflake", color: "green" });
  });

  it("reveals on/after the day", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/FROM participants me JOIN events e .* WHERE e.public_id = \?/, [row({ exchange_date: "2020-01-01" })]);
    fake.on(/FROM assignments a JOIN participants rp/, [{ id: 3, name: "Ana", wishlist: null }]);
    const r = await request(app).get("/api/app/my/events/EVT").set("Cookie", sessionCookie);
    expect(r.body.receiver.name).toBe("Ana");
    expect(r.body.reveal_at).toBeNull();
  });
});

describe("templates API", () => {
  it("Free workspaces get no templates (Pro feature)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer", plan: "free" }]);
    const r = await request(app).get("/api/app/templates").set("Cookie", sessionCookie);
    expect(r.body).toEqual({ ok: true, items: [], locked: true });
    expect(fake.find(/FROM event_templates/)).toBeUndefined();
  });

  it("lists only this workspace's templates; participants can't", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer", plan: "pro" }]);
    fake.on(/FROM event_templates WHERE tenant_id = \?/, [{ id: 1, name: "Sweaters", icon: "snowflake", color: "green", match_mode: "none", allow_wishlists: 1, budget_min: null, budget_max: null, currency: "USD", theme_rules: null, reveal_mode: "private" }]);
    const r = await request(app).get("/api/app/templates").set("Cookie", sessionCookie);
    expect(r.body.items[0]).toMatchObject({ name: "Sweaters", allow_wishlists: true });
    expect(fake.find(/FROM event_templates WHERE tenant_id = \?/)!.params).toEqual([7]);
    fake.reset();
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).get("/api/app/templates").set("Cookie", sessionCookie)).status).toBe(403);
  });

  it("delete is tenant-scoped", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/DELETE FROM event_templates/, { affectedRows: 0, insertId: 0 });
    expect((await request(app).delete("/api/app/templates/99").set("Cookie", sessionCookie)).status).toBe(404);
    expect(fake.find(/DELETE FROM event_templates/)!.params).toEqual([99, 7]);
  });
});

describe("audit regressions", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "custom", event_type_name: "Create your own", event_type_name_es: "Crea el tuyo", name: "X", description: null,
    status: "drawn", plan: "free", paid_at: null, budget_min: null, budget_max: null, currency: "USD", exchange_date: "2099-12-24", rsvp_deadline: null, location: null,
    allow_wishlists: 1, drawn_at: null, created_at: "", custom_name: "Ugly Sweater Swap", custom_icon: "snowflake", custom_color: "green", match_mode: "draw",
    theme_rules: "Knitted", reveal_mode: "together", requires_pro: 1, uses_draw: 1, participant_count: 3, joined_count: 3, max_participants_per_event: 20, tenant_plan_raw: "pro",
    subscription_status: "active", current_period_end: "2099-01-01 00:00:00", past_due_since: null, ...over,
  });

  it("can't clear the date of a 'reveal together' exchange (would leak every match)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [ev()]);
    const r = await request(app).patch("/api/app/events/5").set("Cookie", sessionCookie).send({ exchange_date: null });
    expect(r.body.error).toBe("validation.revealNeedsDate");
  });

  it("a 'together' exchange with no date stays hidden", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/FROM participants me JOIN events e .* WHERE e.public_id = \?/, [{ ...ev({ exchange_date: null }), me_id: 11, me_name: "Me", me_wishlist: null, me_status: "joined" }]);
    const r = await request(app).get("/api/app/my/events/EVT").set("Cookie", sessionCookie);
    expect(r.body.receiver).toBeNull();
    expect(fake.find(/FROM assignments a/)).toBeUndefined();
  });

  it("adding people to an unpaid exchange queues invites instead of sending them; resend is refused", async () => {
    signIn(fake, { full_name: "Org" }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [ev({ status: "pending_payment", tenant_plan_raw: "free", subscription_status: "none" })]);
    fake.on(/SELECT id FROM participants WHERE event_id = \? AND tenant_id = \? AND email = \?/, [{ id: 77 }]);
    const r = await request(app).post("/api/app/events/5/participants").set("Cookie", sessionCookie).send({ participants: [{ name: "New", email: "new@example.com" }] });
    expect(r.status).toBe(201);
    expect(r.body.invited).toBe(0);
    expect(__test.emailDryRuns).toHaveLength(0);
    expect(fake.find(/UPDATE events SET invites_pending = 1/)).toBeTruthy();
    expect((await request(app).post("/api/app/events/5/participants/77/resend").set("Cookie", sessionCookie)).body.error).toBe("errors.paymentRequired");
  });

  it("invites use the custom name + language", async () => {
    signIn(fake, { full_name: "Org" }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [ev({ status: "open", custom_name: null, event_type_slug: "book_swap", match_mode: null, reveal_mode: "private" })]);
    fake.on(/SELECT id FROM participants WHERE event_id = \? AND tenant_id = \? AND email = \?/, [{ id: 77 }]);
    await request(app).post("/api/app/events/5/participants").set("Cookie", sessionCookie).set("Accept-Language", "es").send({ participants: [{ name: "New", email: "new@example.com" }] });
    expect(__test.emailDryRuns[0].html).toContain("Crea el tuyo");
  });

  it("switching a design to 'no draw' forces private reveal and drops exclusions", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("custom", { requires_pro: 1 })]);
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send({ ...base, eventTypeSlug: "custom", custom: { ...design, matchMode: "none", revealMode: "together" }, exclusions: [{ a: "p0@example.com", b: "p1@example.com", bidirectional: true }], participants: people(2) });
    expect(r.status).toBe(201);
    expect(insertEvent().params[9]).toBe("private");
    expect(fake.find(/INSERT IGNORE INTO exclusions/)).toBeUndefined();
  });

  it("'together' draw email doesn't promise an instant reveal", () => {
    expect(tplAssignment("en", { eventName: "X", link: "https://x", revealOn: "2026-12-24" }).text).toContain("together on 2026-12-24");
  });

  it("the Command Center can't make 'Create your own' free", async () => {
    signIn(fake, { platform_role: "owner" });
    fake.on(/SELECT slug FROM event_types WHERE id = \?/, [{ slug: "custom" }]);
    expect((await request(app).patch("/api/admin/event-types/6").set("Cookie", sessionCookie).send({ requires_pro: false })).body.error).toBe("errors.customIsPro");
  });
});
