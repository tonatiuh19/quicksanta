import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
beforeEach(() => {
  fake = installFakeDb();
});

describe("wizard drafts (one per signed-in user)", () => {
  it("require a session", async () => {
    expect((await request(app).get("/api/wizard/draft")).status).toBe(401);
    expect((await request(app).put("/api/wizard/draft").send({ step: "people", data: {} })).status).toBe(401);
    expect((await request(app).delete("/api/wizard/draft")).status).toBe(401);
    expect(fake.find(/wizard_drafts/)).toBeUndefined();
  });

  it("GET returns null when there is none, and only unexpired drafts of this user", async () => {
    signIn(fake, { id: 7 });
    const r = await request(app).get("/api/wizard/draft").set("Cookie", sessionCookie);
    expect(r.body).toEqual({ ok: true, draft: null });
    const q = fake.find(/FROM wizard_drafts/)!;
    expect(q.params).toEqual([7]);
    expect(q.sql).toMatch(/updated_at > UTC_TIMESTAMP\(\) - INTERVAL 30 DAY/);
  });

  it("GET parses stored JSON (string or object) and ignores corrupt rows", async () => {
    signIn(fake, { id: 7 });
    fake.once(/FROM wizard_drafts/, [{ step: "people", data: JSON.stringify({ name: "Family" }), updated_at: "2026-11-26 10:00:00" }]);
    expect((await request(app).get("/api/wizard/draft").set("Cookie", sessionCookie)).body.draft).toEqual({ step: "people", data: { name: "Family" }, updated_at: "2026-11-26 10:00:00" });
    fake.once(/FROM wizard_drafts/, [{ step: "people", data: "{not json", updated_at: "2026-11-26 10:00:00" }]);
    expect((await request(app).get("/api/wizard/draft").set("Cookie", sessionCookie)).body.draft).toBeNull();
    fake.once(/FROM wizard_drafts/, [{ step: "people", data: [1, 2], updated_at: "2026-11-26 10:00:00" }]);
    expect((await request(app).get("/api/wizard/draft").set("Cookie", sessionCookie)).body.draft).toBeNull();
  });

  it("PUT upserts the session user's single draft (user id never from the body)", async () => {
    signIn(fake, { id: 7 });
    const r = await request(app).put("/api/wizard/draft").set("Cookie", sessionCookie).send({ step: "rules", data: { name: "Office", user_id: 99 } });
    expect(r.status).toBe(200);
    const w = fake.find(/INSERT INTO wizard_drafts/)!;
    expect(w.sql).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(w.params[0]).toBe(7);
    expect(w.params[1]).toBe("rules");
    expect(JSON.parse(String(w.params[2]))).toMatchObject({ name: "Office" });
  });

  it("PUT validates the step and the payload size", async () => {
    signIn(fake);
    expect((await request(app).put("/api/wizard/draft").set("Cookie", sessionCookie).send({ step: "hack", data: {} })).status).toBe(400);
    expect((await request(app).put("/api/wizard/draft").set("Cookie", sessionCookie).send({ step: "people", data: [1] })).status).toBe(400);
    const big = await request(app).put("/api/wizard/draft").set("Cookie", sessionCookie).send({ step: "people", data: { description: "x".repeat(70_000) } });
    expect(big.status).toBe(413);
    expect(big.body.error).toBe("errors.draftTooLarge");
    expect(fake.find(/INSERT INTO wizard_drafts/)).toBeUndefined();
  });

  it("DELETE removes only the session user's draft", async () => {
    signIn(fake, { id: 7 });
    expect((await request(app).delete("/api/wizard/draft").set("Cookie", sessionCookie)).status).toBe(200);
    expect(fake.find(/DELETE FROM wizard_drafts WHERE user_id = \?/)!.params).toEqual([7]);
  });

  it("launching the wizard drops the draft", async () => {
    signIn(fake, { id: 7 });
    fake.on(/FROM event_types WHERE slug = \?/, [{ id: 1, slug: "secret_santa", name_en: "SS", name_es: "SS", icon: "gift", uses_draw: 1, requires_pro: 0, wishlist_mode: "off", is_active: 1 }]);
    const people = [1, 2, 3].map((i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send({ eventTypeSlug: "secret_santa", name: "Party", currency: "USD", organizerName: "Org", includeMe: false, exclusions: [], sendInvites: false, participants: people });
    expect(r.status).toBe(201);
    expect(fake.find(/DELETE FROM wizard_drafts WHERE user_id = \?/)!.params).toEqual([7]);
  });

  it("the daily cron purges drafts untouched for 30 days", async () => {
    process.env.CRON_SECRET = "s3cret";
    const r = await request(app).get("/api/cron/cleanup").set("Authorization", "Bearer s3cret");
    expect(r.body).toMatchObject({ ok: true, drafts_deleted: 1 });
    expect(fake.find(/DELETE FROM wizard_drafts WHERE updated_at < UTC_TIMESTAMP\(\) - INTERVAL 30 DAY/)).toBeTruthy();
    delete process.env.CRON_SECRET;
  });
});
