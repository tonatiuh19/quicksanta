import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, cleanSubjectText, createServer, formatJoinCode, inviteLinkState, isRealUtcDateTime, newJoinCode, normalizeJoinCode, tplLinkJoined } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const CODE = "7K4PQX9M";
const H = { "X-Tenant-Id": "7" };

/** loadTenantEvent row (free workspace → 20 people). */
const tenantEvent = (over: Record<string, unknown> = {}) => ({
  id: 5, public_id: "EVPUB", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", status: "open", plan: "free", currency: "USD",
  allow_wishlists: 0, participant_count: 4, joined_count: 2, uses_draw: 1, created_at: "2026-11-01 00:00:00",
  max_participants_per_event: 20, tenant_plan_raw: "free", subscription_status: "none", current_period_end: null, past_due_since: null, ...over,
});
/** findByCode row. */
const codeRow = (over: Record<string, unknown> = {}) => ({
  id: 5, tenant_id: 7, public_id: "EVPUB", name: "Office", status: "open", exchange_date: null, budget_min: null, budget_max: null, currency: "USD", theme_rules: null, custom_name: null,
  join_enabled: 1, join_max: null, join_expires_at: null, created_by: 1, name_en: "Secret Santa", name_es: "Amigo secreto", tenant_name: "Acme", tenant_status: "active",
  organizer: "Olga Org", organizer_email: "olga@example.com", organizer_locale: "en", people: 4, via_link: 1, ...over,
});
const LOAD_EVENT = /FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id WHERE e.id = \? AND e.tenant_id = \?/;
const BY_CODE = /WHERE e.join_code = \?/;
const LOCK = /FROM events WHERE id = \? AND join_code = \? FOR UPDATE/;
const MINE = /FROM participants WHERE event_id = \? AND email = \? LIMIT 1 FOR UPDATE/;
const COUNTS = /SELECT status, joined_via FROM participants WHERE event_id = \? FOR UPDATE/;
const seatRows = (people: number, viaLink: number) => Array.from({ length: people }, (_, i) => ({ status: i % 2 ? "joined" : "invited", joined_via: i < viaLink ? "link" : "email" }));

function joinable(fake: FakeDb, o: { code?: Record<string, unknown>; event?: Record<string, unknown>; lock?: Record<string, unknown> | null; mine?: Record<string, unknown> | null; counts?: Record<string, unknown> } = {}) {
  fake.on(BY_CODE, [codeRow(o.code)]);
  fake.on(LOAD_EVENT, [tenantEvent(o.event)]);
  fake.on(LOCK, [{ id: 5, status: "open", join_enabled: 1, join_max: null, join_expires_at: null, ...o.lock }]);
  fake.on(MINE, o.mine ? [o.mine] : []);
  const c = { people: 4, via_link: 1, ...o.counts } as { people: number; via_link: number };
  fake.on(COUNTS, [...seatRows(c.people, c.via_link), { status: "removed", joined_via: "link" }, { status: "declined", joined_via: "email" }]);
}
const join = (body: object = {}) => request(app).post(`/api/join-code/${formatJoinCode(CODE)}`).set("Cookie", sessionCookie).send(body);

beforeEach(() => {
  fake = installFakeDb();
});

describe("invite codes (pure)", () => {
  it("generates 8 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) expect(newJoinCode()).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  });
  it("normalizes what people type (case, dash, spaces) and rejects impossible codes", () => {
    expect(normalizeJoinCode(" 7k4p-qx9m ")).toBe(CODE);
    expect(normalizeJoinCode("7K4P QX9M")).toBe(CODE);
    expect(normalizeJoinCode("7K4P-QX9")).toBeNull();
    expect(normalizeJoinCode("OOOO-1111")).toBeNull(); // O/1 never appear in codes
    expect(formatJoinCode(CODE)).toBe("7K4P-QX9M");
  });
  it("state priority: off → closed → expired → full → active", () => {
    const base = { enabled: true, status: "open", expires_at: null, max: null, joined_via_link: 0, seats_left: 5 };
    expect(inviteLinkState({ ...base, enabled: false })).toBe("off");
    expect(inviteLinkState({ ...base, enabled: false, status: "drawn" })).toBe("closed"); // the draw switches it off: still reads "closed"
    expect(inviteLinkState({ ...base, status: "drawn" })).toBe("closed");
    expect(inviteLinkState({ ...base, status: "pending_payment" })).toBe("closed");
    expect(inviteLinkState({ ...base, expires_at: "2020-01-01 00:00:00" })).toBe("expired");
    expect(inviteLinkState({ ...base, seats_left: 0 })).toBe("full");
    expect(inviteLinkState({ ...base, max: 3, joined_via_link: 3 })).toBe("full");
    expect(inviteLinkState({ ...base, expires_at: "2099-01-01 00:00:00" })).toBe("active");
  });
  it("real dates only (regex-valid but impossible dates are rejected)", () => {
    expect(isRealUtcDateTime("2026-12-24")).toBe(true);
    expect(isRealUtcDateTime("2026-12-24 23:59:59")).toBe(true);
    expect(isRealUtcDateTime("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-31", "2027-02-29", "2026-13-01", "2026-12-24 25:00", "2026-12-24 10:99", "2026-1-1"]) expect(isRealUtcDateTime(bad)).toBe(false);
  });
  it("subject text: no newlines/control chars, collapsed, capped", () => {
    expect(cleanSubjectText("Ana\r\nBcc: evil@x.com\u2028 hi", 60)).toBe("Ana Bcc: evil@x.com hi");
    expect(cleanSubjectText("x".repeat(80), 40)).toHaveLength(40);
  });
  it("organizer email escapes the joiner's name", () => {
    expect(tplLinkJoined("en", { who: "<b>x</b>", eventName: "Office", link: "https://q/app" }).html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("organizer: invite link settings", () => {
  it("needs participants.manage in the workspace (participants are refused)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).get("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H)).status).toBe(403);
    expect((await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ enabled: true })).status).toBe(403);
  });

  it("enabling creates a code (scoped to the tenant) and reports seats", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent()]);
    fake.once(/SELECT join_code FROM events/, [{ join_code: null }]);
    fake.on(/SELECT e.join_code, e.join_enabled/, [{ join_code: CODE, join_enabled: 1, join_max: null, join_expires_at: null, via_link: 0 }]);
    const r = await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ enabled: true });
    expect(r.status).toBe(200);
    const setCode = fake.find(/UPDATE events SET join_code = \? WHERE id = \? AND tenant_id = \?/)!;
    expect(setCode.params.slice(1)).toEqual([5, 7]);
    expect(fake.find(/UPDATE events SET join_enabled = \?/)!.params).toEqual([1, 5, 7]);
    expect(r.body.link).toMatchObject({ enabled: true, code: "7K4P-QX9M", state: "active", seats_left: 16 });
    expect(r.body.link.url).toMatch(/\/j\/7K4P-QX9M$/);
  });

  it("impossible expiry dates are a 400, not a 500", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent()]);
    const r = await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ expires_at: "2099-02-31" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation.date");
    expect(fake.find(/UPDATE events SET join_/)).toBeUndefined();
  });

  it("can't be turned on after the draw; validates cap and expiry", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent({ status: "drawn" })]);
    expect((await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ enabled: true })).body.error).toBe("errors.joinClosed");
    expect((await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ max: 0 })).status).toBe(400);
    expect((await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ expires_at: "2020-01-01" })).body.error).toBe("validation.expiryPast");
    expect((await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ expires_at: "tomorrow" })).status).toBe(400);
  });

  it("a date-only expiry means the end of that day (UTC); null clears cap/expiry", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent()]);
    await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ max: 10, expires_at: "2099-12-24" });
    expect(fake.find(/UPDATE events SET join_max = \?, join_expires_at = \?/)!.params).toEqual([10, "2099-12-24 23:59:59", 5, 7]);
    await request(app).put("/api/app/events/5/invite-link").set("Cookie", sessionCookie).set(H).send({ max: null, expires_at: null });
    expect(fake.findAll(/UPDATE events SET join_max = \?, join_expires_at = \?/)[1].params).toEqual([null, null, 5, 7]);
  });

  it("regenerate replaces the code (old one stops matching) and retries on a collision", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent()]);
    fake.once(/UPDATE events SET join_code = \?/, () => {
      throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
    });
    const r = await request(app).post("/api/app/events/5/invite-link/regenerate").set("Cookie", sessionCookie).set(H);
    expect(r.status).toBe(200);
    expect(fake.findAll(/UPDATE events SET join_code = \?/)).toHaveLength(2);
    expect(fake.find(/INSERT INTO audit_log/)).toBeTruthy();
  });
});

describe("public preview", () => {
  it("unknown / malformed / cancelled / suspended → the same 404", async () => {
    expect((await request(app).get("/api/join-code/nope")).body.error).toBe("errors.joinCodeInvalid");
    expect((await request(app).get("/api/join-code/7K4P-QX9M")).status).toBe(404);
    fake.once(BY_CODE, [codeRow({ status: "cancelled" })]);
    expect((await request(app).get("/api/join-code/7K4P-QX9M")).status).toBe(404);
    fake.once(BY_CODE, [codeRow({ tenant_status: "suspended" })]);
    expect((await request(app).get("/api/join-code/7K4P-QX9M")).status).toBe(404);
  });

  it("shows the exchange and why it can't be joined (paused / closed / full), never the event id to strangers", async () => {
    fake.on(LOAD_EVENT, [tenantEvent()]);
    fake.once(BY_CODE, [codeRow()]);
    const ok = (await request(app).get("/api/join-code/7k4p-qx9m")).body.preview;
    expect(ok).toMatchObject({ event_name: "Office", organizer: "Olga Org", people: 4, state: "open", my_status: null, event_public_id: null });
    // Paused (e.g. the link leaked): 404 that reveals nothing about the exchange.
    fake.once(BY_CODE, [codeRow({ join_enabled: 0 })]);
    const paused = await request(app).get("/api/join-code/7K4P-QX9M");
    expect(paused.status).toBe(404);
    expect(paused.body).toEqual({ error: "errors.joinPaused" });
    fake.once(BY_CODE, [codeRow({ status: "drawn" })]);
    expect((await request(app).get("/api/join-code/7K4P-QX9M")).body.preview.state).toBe("closed");
    fake.once(BY_CODE, [codeRow({ people: 20 })]);
    expect((await request(app).get("/api/join-code/7K4P-QX9M")).body.preview.state).toBe("full");
  });
});

describe("joining with a code", () => {
  it("requires a session", async () => {
    expect((await request(app).post("/api/join-code/7K4P-QX9M").send({})).status).toBe(401);
  });

  it("a new person joins instantly as a participant (via link) and the organizer is emailed", async () => {
    signIn(fake, { id: 3, email: "new@example.com", full_name: "Nia New" });
    joinable(fake);
    const r = await join();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "joined", already: false, event_public_id: "EVPUB", tenant_id: 7 });
    const ins = fake.find(/INSERT INTO participants/)!;
    expect(ins.sql).toMatch(/'joined', 'link'/);
    expect(ins.params.slice(1)).toEqual([7, 5, 3, "Nia New", "new@example.com"]);
    expect(fake.find(/INSERT IGNORE INTO tenant_members/)!.params).toEqual([7, 3]);
    const mail = __test.emailDryRuns.find((m) => m.to === "olga@example.com")!;
    expect(mail.subject).toBe("New person in “Office”: Nia New");
    expect(mail.html).toContain("new@example.com"); // who it really is, whatever name they typed
  });

  it("someone already invited by email is accepted without taking a new seat", async () => {
    signIn(fake, { id: 3, email: "ana@example.com" });
    joinable(fake, { mine: { id: 44, status: "invited" }, counts: { people: 20 } }); // full, but Ana already has her seat
    const r = await join();
    expect(r.status).toBe(200);
    expect(fake.find(/UPDATE participants SET user_id = \?, status = 'joined'/)!.params).toEqual([3, 44]);
    expect(fake.find(/INSERT INTO participants/)).toBeUndefined();
  });

  it("already joined → idempotent, no email", async () => {
    signIn(fake, { id: 3, email: "ana@example.com" });
    joinable(fake, { mine: { id: 44, status: "joined" } });
    expect((await join()).body).toMatchObject({ already: true });
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it.each([
    ["paused", { lock: { join_enabled: 0 } }, 409, "errors.joinPaused"],
    ["after the draw", { lock: { status: "drawn" } }, 409, "errors.joinClosed"],
    ["waiting for payment", { lock: { status: "pending_payment" } }, 409, "errors.joinClosed"],
    ["expired", { lock: { join_expires_at: "2020-01-01 00:00:00" } }, 409, "errors.joinExpired"],
    ["plan limit reached", { counts: { people: 20 } }, 409, "errors.joinFull"],
    ["link cap reached", { lock: { join_max: 1 }, counts: { via_link: 1 } }, 409, "errors.joinFull"],
    ["removed by the organizer", { mine: { id: 44, status: "removed" } }, 403, "errors.joinRemoved"],
    ["regenerated since the preview", { lock: null }, 404, "errors.joinCodeInvalid"],
  ])("refused when %s", async (_label, o: any, status, error) => {
    signIn(fake, { id: 3, email: "x@example.com" });
    joinable(fake, o);
    if (o.lock === null) fake.once(LOCK, []);
    const r = await join();
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(error);
    expect(fake.find(/INSERT INTO participants/)).toBeUndefined();
  });

  it("a declined person rejoining needs a free seat", async () => {
    signIn(fake, { id: 3, email: "x@example.com" });
    joinable(fake, { mine: { id: 44, status: "declined" }, counts: { people: 20 } });
    expect((await join()).body.error).toBe("errors.joinFull");
  });

  it("a typed name is cleaned (no newlines) before it's stored or emailed", async () => {
    signIn(fake, { id: 3, email: "x@example.com", full_name: "" });
    joinable(fake);
    await join({ name: "Your account is locked\nVisit evil.example" });
    expect(fake.find(/INSERT INTO participants/)!.params[4]).toBe("Your account is locked Visit evil.example");
    expect(__test.emailDryRuns[0].subject).not.toMatch(/[\r\n]/);
  });

  it("uses the typed name when the account has none, and never emails the organizer about themself", async () => {
    signIn(fake, { id: 1, email: "olga@example.com", full_name: "olga@example.com" });
    joinable(fake);
    await join({ name: "Olga" });
    expect(fake.find(/INSERT INTO participants/)!.params[4]).toBe("Olga");
    expect(__test.emailDryRuns).toHaveLength(0);
  });
});

describe("draw ↔ invite link", () => {
  it("running the draw switches the link off and reads people/rules with locking reads (no stale snapshot)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD_EVENT, [tenantEvent()]);
    fake.on(/FROM participants WHERE event_id = \? AND tenant_id = \? AND status IN/, [1, 2, 3].map((id) => ({ id, email: `p${id}@x.com`, user_id: null, status: "joined" })));
    const r = await request(app).post("/api/app/events/5/draw").set("Cookie", sessionCookie).set(H).send({});
    expect(r.status).toBe(200);
    expect(fake.find(/UPDATE events SET status = 'drawn', drawn_at = UTC_TIMESTAMP\(\), join_enabled = 0/)).toBeTruthy();
    expect(fake.find(/SELECT id, email, user_id, status FROM participants .* FOR UPDATE/)).toBeTruthy();
    expect(fake.find(/FROM exclusions WHERE event_id = \? AND tenant_id = \? FOR UPDATE/)).toBeTruthy();
  });
});
