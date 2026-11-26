import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", description: null,
  status: "open", budget_min: "20.00", budget_max: "30.00", currency: "USD", exchange_date: "2026-12-20", rsvp_deadline: null, location: null,
  allow_wishlists: 1, drawn_at: null, created_at: "2026-11-01 00:00:00", participant_count: 3, joined_count: 2, uses_draw: 1, max_participants_per_event: 100, ...over,
});

beforeEach(() => {
  fake = installFakeDb();
});

describe("tenant scoping + roles", () => {
  it("403 when the user is not a member of the requested tenant", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    const r = await request(app).get("/api/app/events").set("Cookie", sessionCookie).set("X-Tenant-Id", "8");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("errors.noTenantAccess");
  });

  it("participants cannot manage events", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).get("/api/app/events").set("Cookie", sessionCookie)).status).toBe(403);
  });

  it("suspended tenants are locked (423)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer", tenant_status: "suspended" }]);
    expect((await request(app).get("/api/app/events").set("Cookie", sessionCookie)).status).toBe(423);
  });
});

describe("GET /api/app/events (server-side grid)", () => {
  it("scopes by tenant, applies filters/search/sort and paginates", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT slug FROM event_types/, [{ slug: "secret_santa" }]);
    fake.on(/SELECT COUNT\(\*\) AS c FROM events e/, [{ c: 41 }]);
    fake.on(/FROM events e JOIN event_types et .* LIMIT 20 OFFSET 20/, [eventRow()]);
    const r = await request(app)
      .get("/api/app/events")
      .query({ page: 2, limit: 20, sort_by: "name", sort_dir: "ASC", status: "open", type: "secret_santa", q: "off" })
      .set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    expect(r.body.pagination).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
    expect(r.body.items[0]).toMatchObject({ id: 5, budget_min: 20, allow_wishlists: true });
    const page = fake.find(/LIMIT 20 OFFSET 20/)!;
    expect(page.sql).toContain("WHERE e.tenant_id = ? AND e.status = ? AND et.slug = ? AND (e.name LIKE ? ESCAPE '!' OR e.location LIKE ? ESCAPE '!')");
    expect(page.sql).toContain("ORDER BY e.name ASC, e.id ASC");
    expect(page.params).toEqual([7, "open", "secret_santa", "%off%", "%off%"]);
  });
});

describe("draw", () => {
  beforeEach(() => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
  });

  it("assigns everyone, locks the event and emails givers", async () => {
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow()]);
    fake.on(/SELECT id, email, user_id FROM participants/, [
      { id: 1, email: "a@example.com" },
      { id: 2, email: "b@example.com" },
      { id: 3, email: "c@example.com" },
      { id: 4, email: "d@example.com" },
    ]);
    fake.on(/FROM exclusions WHERE event_id/, [{ giver_participant_id: 1, receiver_participant_id: 2, bidirectional: 1 }]);
    const r = await request(app).post("/api/app/events/5/draw").set("Cookie", sessionCookie).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ assigned: 4, notified: 4 });
    const ins = fake.find(/INSERT INTO assignments/)!;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < ins.params.length; i += 4) pairs.push([ins.params[i + 2] as number, ins.params[i + 3] as number]);
    expect(pairs).toHaveLength(4);
    expect(pairs.find(([g, rr]) => (g === 1 && rr === 2) || (g === 2 && rr === 1))).toBeUndefined();
    expect(__test.emailDryRuns.every((m) => m.template === "assignment")).toBe(true);
  });

  it("refuses when already drawn or a concurrent draw won", async () => {
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow({ status: "drawn" })]);
    expect((await request(app).post("/api/app/events/5/draw").set("Cookie", sessionCookie)).status).toBe(409);
  });

  it("refuses for services without a draw", async () => {
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow({ uses_draw: 0 })]);
    expect((await request(app).post("/api/app/events/5/draw").set("Cookie", sessionCookie)).body.error).toBe("errors.drawNotSupported");
  });

  it("404 for events of another tenant", async () => {
    expect((await request(app).post("/api/app/events/5/draw").set("Cookie", sessionCookie)).status).toBe(404);
  });
});

describe("participants", () => {
  beforeEach(() => {
    signIn(fake, { full_name: "Org" }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow()]);
  });

  it("adds new people, skips ones already in, re-invites removed ones, invites", async () => {
    fake.on(/SELECT email FROM participants WHERE event_id = \? AND tenant_id = \? AND status IN/, [{ email: "dup@example.com" }]);
    fake.on(/SELECT id FROM participants WHERE event_id = \? AND tenant_id = \? AND email = \?/, [{ id: 77 }]);
    const r = await request(app)
      .post("/api/app/events/5/participants")
      .set("Cookie", sessionCookie)
      .send({ participants: [{ name: "Dup", email: "dup@example.com" }, { name: "New", email: "new@example.com" }] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, added: 1, invited: 1, skipped: 1 });
    expect(fake.find(/ON DUPLICATE KEY UPDATE name = VALUES\(name\), status = IF\(status IN \('removed','declined'\)/)).toBeTruthy();
  });

  it("enforces the tenant participant limit", async () => {
    fake.reset();
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    // Free exchange: 19 people + 2 new > 20 → needs Pro (≤ 100).
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [eventRow({ participant_count: 19, plan: "free", tenant_plan: "free" })]);
    const r = await request(app)
      .post("/api/app/events/5/participants")
      .set("Cookie", sessionCookie)
      .send({ participants: [{ name: "A", email: "a1@example.com" }, { name: "B", email: "b1@example.com" }, { name: "B again", email: "b1@example.com" }] });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "errors.needsPro", free_max: 20, pro_max: 100 });
  });

  it("exclusions must reference two participants of the same event", async () => {
    fake.on(/SELECT COUNT\(\*\) AS c FROM participants WHERE id IN/, [{ c: 1 }]);
    const r = await request(app).post("/api/app/events/5/exclusions").set("Cookie", sessionCookie).send({ giver_participant_id: 1, receiver_participant_id: 99 });
    expect(r.status).toBe(400);
  });
});

describe("participant views", () => {
  it("reveals my receiver (with wishlist) only after the draw and marks it viewed", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/FROM participants me JOIN events e .* WHERE e.public_id = \?/, [{ ...eventRow({ status: "drawn" }), me_id: 11, me_name: "Me", me_wishlist: "socks", me_status: "joined" }]);
    fake.on(/FROM assignments a JOIN participants rp/, [{ id: 3, name: "Ana", wishlist: "books" }]);
    const r = await request(app).get("/api/app/my/events/EVT").set("Cookie", sessionCookie);
    expect(r.body.receiver).toEqual({ name: "Ana", wishlist: "books" });
    expect(fake.find(/UPDATE assignments SET viewed_at/)).toBeTruthy();
  });

  it("no receiver before the draw", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/FROM participants me JOIN events e .* WHERE e.public_id = \?/, [{ ...eventRow(), me_id: 11, me_name: "Me", me_wishlist: null, me_status: "joined" }]);
    const r = await request(app).get("/api/app/my/events/EVT").set("Cookie", sessionCookie);
    expect(r.body.receiver).toBeNull();
    expect(fake.find(/FROM assignments a/)).toBeUndefined();
  });
});

describe("join flow", () => {
  const invite = { id: 4, tenant_id: 7, event_id: 5, name: "Ana", email: "ana@example.com", status: "invited", event_name: "Office", event_status: "open", exchange_date: null, budget_min: null, budget_max: null, currency: "USD", event_public_id: "EVT", name_en: "Secret Santa", name_es: "Amigo secreto", tenant_name: "T", tenant_status: "active" };

  it("previews an invite with a masked email", async () => {
    fake.on(/WHERE p.invite_token_hash = \?/, [invite]);
    const r = await request(app).get("/api/join/abcdefghijklmnopqrstuv");
    expect(r.body.invite).toMatchObject({ name: "Ana", email_hint: "a•••@example.com", type_name: "Secret Santa" });
  });

  it("rejects joining from a different account", async () => {
    signIn(fake, { email: "other@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [invite]);
    const r = await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("errors.inviteWrongAccount");
  });

  it("accepting links the user and adds a participant membership", async () => {
    signIn(fake, { email: "ana@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [invite]);
    const r = await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true });
    expect(r.body).toMatchObject({ ok: true, status: "joined", tenant_id: 7 });
    expect(fake.find(/INSERT IGNORE INTO tenant_members .* 'participant'/)).toBeTruthy();
  });

  it("malformed tokens are 404 without touching the DB", async () => {
    expect((await request(app).get("/api/join/x")).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });
});
