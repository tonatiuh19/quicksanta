import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const SANTA = { id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "", description_es: "", icon: "gift", uses_draw: 1, is_active: 1, sort_order: 1 };

const input = (over: Record<string, unknown> = {}) => ({
  eventTypeSlug: "secret_santa",
  name: "Office Party",
  currency: "USD",
  budgetMin: 20,
  budgetMax: 30,
  exchangeDate: "2026-12-20",
  allowWishlists: true,
  organizerName: "Alex Gomez",
  includeMe: true,
  participants: [
    { name: "Ana", email: "ana@example.com" },
    { name: "Bob", email: "bob@example.com" },
    { name: "Carla", email: "carla@example.com" },
    { name: "Me again", email: "me@example.com" },
  ],
  exclusions: [{ a: "ana@example.com", b: "bob@example.com", bidirectional: true }],
  sendInvites: true,
  ...over,
});

beforeEach(() => {
  fake = installFakeDb();
  fake.on(/FROM event_types WHERE slug = \?/, [SANTA]);
});

describe("POST /api/wizard/launch", () => {
  it("requires a session", async () => {
    expect((await request(app).post("/api/wizard/launch").send(input())).status).toBe(401);
  });

  it("creates tenant + organizer membership + event + participants + exclusions and invites everyone but me", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send(input());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, invited: 3 });
    expect(fake.find(/INSERT INTO tenants/)!.params[1]).toBe("Alex's exchanges");
    expect(fake.find(/INSERT INTO tenant_members .* 'organizer'/)).toBeTruthy();
    const people = fake.findAll(/INSERT INTO participants/);
    // Organizer deduped (me@example.com listed twice).
    expect(people.map((p) => p.params[5])).toEqual(["me@example.com", "ana@example.com", "bob@example.com", "carla@example.com"]);
    expect(people[0].params[6]).toBe("joined");
    expect(fake.findAll(/INSERT IGNORE INTO exclusions/)).toHaveLength(1);
    expect(__test.emailDryRuns.map((m) => m.to)).toEqual(["ana@example.com", "bob@example.com", "carla@example.com"]);
    expect(__test.emailDryRuns[0].text).toMatch(/\/join\/[A-Za-z0-9_-]+/);
  });

  it("reuses the tenant the user already organizes and enforces its event limit", async () => {
    signIn(fake, {}, [{ tenant_id: 9, role: "organizer" }]);
    fake.on(/SELECT plan, subscription_status, current_period_end, past_due_since, max_events/, [{ max_events: 1, max_participants_per_event: 100, active: 1 }]);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send(input());
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("errors.eventLimit");
    expect(fake.find(/INSERT INTO tenants/)).toBeUndefined();
  });

  it("validates minimum participants for draw-based services", async () => {
    signIn(fake);
    const r = await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send(input({ participants: [{ name: "Ana", email: "ana@example.com" }], exclusions: [] }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "validation.minParticipants", min: 3 });
  });

  it("rejects impossible exclusion sets before writing anything", async () => {
    signIn(fake);
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send(input({ exclusions: [{ a: "me", b: "ana@example.com", bidirectional: true }, { a: "me", b: "bob@example.com", bidirectional: true }, { a: "me", b: "carla@example.com", bidirectional: true }] }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation.drawImpossible");
    expect(fake.find(/INSERT INTO/)).toBeUndefined();
  });

  it("rejects inverted budgets and unknown services", async () => {
    signIn(fake);
    expect((await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send(input({ budgetMin: 50, budgetMax: 10 }))).body.error).toBe("validation.budgetRange");
    fake.reset();
    signIn(fake);
    expect((await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send(input())).body.error).toBe("validation.eventType");
  });
});
