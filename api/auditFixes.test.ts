/** Regression tests for the deep-audit findings. */
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
beforeEach(() => {
  fake = installFakeDb();
});

describe("audit fixes", () => {
  it("re-joining via an invite never restores a removed member's old role", async () => {
    signIn(fake, { email: "ana@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [{ id: 4, tenant_id: 7, event_id: 5, name: "Ana", email: "ana@example.com", status: "invited", event_name: "X", event_status: "open", currency: "USD", event_public_id: "E", name_en: "S", name_es: "S", tenant_name: "T", tenant_status: "active" }]);
    await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true });
    const upd = fake.find(/UPDATE tenant_members SET status = 'active'/)!;
    expect(upd.sql).toContain("role = 'participant'");
    expect(upd.sql).toContain("status = 'removed'");
  });

  it("decliners can't join after the draw", async () => {
    signIn(fake, { email: "ana@example.com" });
    fake.on(/WHERE p.invite_token_hash = \?/, [{ id: 4, tenant_id: 7, email: "ana@example.com", status: "declined", event_status: "drawn", currency: "USD", tenant_status: "active" }]);
    expect((await request(app).post("/api/join/abcdefghijklmnopqrstuv/respond").set("Cookie", sessionCookie).send({ accept: true })).body.error).toBe("errors.alreadyDrawn");
  });

  it("OTP request is throttled per email and never reveals whether the account exists", async () => {
    fake.on(/SELECT COUNT\(\*\) AS c FROM otp_codes WHERE email = \?/, [{ c: 5 }]);
    const r = await request(app).post("/api/auth/otp/request").send({ email: "victim@example.com" });
    expect(r.body).toEqual({ ok: true, sent: true });
    expect(fake.find(/INSERT INTO otp_codes/)).toBeUndefined();
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it("OTP verify locks after too many wrong guesses across codes", async () => {
    fake.on(/FROM otp_codes WHERE email = \? AND consumed_at IS NULL/, [{ id: 9, code_hash: "x", attempts: 0 }]);
    fake.on(/SUM\(attempts\)/, [{ n: 10 }]);
    expect((await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456" })).status).toBe(429);
  });

  it("participants get no tenant-wide KPIs and only their own upcoming exchanges", async () => {
    signIn(fake, { id: 3 }, [{ tenant_id: 7, role: "participant" }]);
    fake.on(/SELECT id, name, slug, plan, max_events/, [{ id: 7, name: "T", slug: "t", plan: "free", max_events: 10, max_participants_per_event: 20 }]);
    fake.on(/SELECT COUNT\(\*\) AS events/, [{ events: 9, open: 4, drawn: 2, participants: 80, joined: 60 }]);
    const r = await request(app).get("/api/app/dashboard").set("Cookie", sessionCookie);
    expect(r.body.kpis).toEqual({ events: 0, open: 0, drawn: 0, participants: 0, joined: 0 });
    expect(fake.find(/JOIN participants me ON me.event_id = e.id AND me.user_id = \?/)!.params).toEqual([3, 7]);
  });

  it("cross-site requests without Origin are blocked via Sec-Fetch-Site", async () => {
    expect((await request(app).post("/api/auth/logout").set("Sec-Fetch-Site", "cross-site")).status).toBe(403);
  });

  it("organizers can't mark people as joined", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    expect((await request(app).patch("/api/app/events/5/participants/1").set("Cookie", sessionCookie).send({ status: "joined" })).status).toBe(400);
  });

  it("granting a platform role never demotes an existing owner", async () => {
    signIn(fake, { platform_role: "owner" });
    await request(app).post("/api/admin/users/invite").set("Cookie", sessionCookie).send({ email: "boss@example.com", full_name: "Boss", platform_role: "admin" });
    expect(fake.find(/INSERT INTO users/)!.sql).toContain("IF(platform_role = 'owner', 'owner', VALUES(platform_role))");
  });

  it("wizard refuses to create a new workspace when the user's own is suspended", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer", tenant_status: "suspended" }]);
    fake.on(/FROM event_types WHERE slug = \?/, [{ id: 1, slug: "secret_santa", name_en: "S", name_es: "S", uses_draw: 1, is_active: 1 }]);
    const r = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", sessionCookie)
      .send({ eventTypeSlug: "secret_santa", name: "X1", currency: "USD", organizerName: "O", includeMe: true, participants: [{ name: "a", email: "a@example.com" }, { name: "b", email: "b@example.com" }], exclusions: [], sendInvites: false, allowWishlists: true });
    expect(r.status).toBe(423);
  });
});
