import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
beforeEach(() => {
  fake = installFakeDb();
});

describe("Command Center access", () => {
  it("401 anonymous, 403 for non-platform users", async () => {
    expect((await request(app).get("/api/admin/overview")).status).toBe(401);
    signIn(fake, { platform_role: null }, [{ tenant_id: 1, role: "organizer" }]);
    expect((await request(app).get("/api/admin/overview").set("Cookie", sessionCookie)).status).toBe(403);
  });

  it("owner gets overview KPIs", async () => {
    signIn(fake, { platform_role: "owner" });
    fake.on(/SELECT \(SELECT COUNT\(\*\) FROM tenants\) AS tenants/, [{ tenants: 3, active_tenants: 2, users: 10, events: 4, open_events: 1, drawn_events: 2, participants: 30, emails_7d: 12, email_failures_7d: 1 }]);
    const r = await request(app).get("/api/admin/overview").set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    expect(r.body.kpis).toMatchObject({ tenants: 3, email_failures_7d: 1 });
  });
});

describe("tenants grid", () => {
  it("search covers name/slug/owner email, filters whitelisted", async () => {
    signIn(fake, { platform_role: "admin" });
    fake.on(/SELECT COUNT\(\*\) AS c FROM tenants t/, [{ c: 1 }]);
    const r = await request(app).get("/api/admin/tenants").query({ q: "acme", status: "suspended", plan: "bogus", sort_by: "event_count", sort_dir: "DESC" }).set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    const page = fake.find(/ORDER BY .* LIMIT/)!;
    expect(page.sql).toContain("WHERE t.status = ? AND (t.name LIKE ? ESCAPE '!' OR t.slug LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!')");
    expect(page.sql).toContain("ORDER BY event_count DESC, t.id DESC");
  });

  it("admins can suspend a tenant (audited)", async () => {
    signIn(fake, { platform_role: "admin" });
    const r = await request(app).patch("/api/admin/tenants/4").set("Cookie", sessionCookie).send({ status: "suspended", max_events: 3 });
    expect(r.status).toBe(200);
    expect(fake.find(/UPDATE tenants SET status = \?, max_events = \?/)!.params).toEqual(["suspended", 3, 4]);
    expect(fake.find(/INSERT INTO audit_log/)!.params[2]).toBe("admin.tenant.update");
  });
});

describe("users + platform roles", () => {
  it("admins cannot grant platform roles", async () => {
    signIn(fake, { platform_role: "admin" });
    fake.on(/SELECT id, platform_role FROM users WHERE id/, [{ id: 5, platform_role: null }]);
    const r = await request(app).patch("/api/admin/users/5").set("Cookie", sessionCookie).send({ platform_role: "admin" });
    expect(r.status).toBe(403);
  });

  it("admins cannot modify owners", async () => {
    signIn(fake, { platform_role: "admin" });
    fake.on(/SELECT id, platform_role FROM users WHERE id/, [{ id: 5, platform_role: "owner" }]);
    expect((await request(app).patch("/api/admin/users/5").set("Cookie", sessionCookie).send({ status: "suspended" })).status).toBe(403);
  });

  it("cannot demote the last owner", async () => {
    signIn(fake, { id: 1, platform_role: "owner" });
    fake.on(/SELECT id, platform_role FROM users WHERE id/, [{ id: 5, platform_role: "owner" }]);
    fake.on(/COUNT\(\*\) AS c FROM users WHERE platform_role = 'owner'/, [{ c: 1 }]);
    const r = await request(app).patch("/api/admin/users/5").set("Cookie", sessionCookie).send({ platform_role: null });
    expect(r.body.error).toBe("errors.lastOwner");
  });

  it("cannot change yourself", async () => {
    signIn(fake, { id: 1, platform_role: "owner" });
    expect((await request(app).patch("/api/admin/users/1").set("Cookie", sessionCookie).send({ status: "suspended" })).body.error).toBe("errors.cannotChangeSelf");
  });

  it("suspending a user kills their sessions", async () => {
    signIn(fake, { id: 1, platform_role: "owner" });
    fake.on(/SELECT id, platform_role FROM users WHERE id/, [{ id: 5, platform_role: null }]);
    await request(app).patch("/api/admin/users/5").set("Cookie", sessionCookie).send({ status: "suspended" });
    expect(fake.find(/UPDATE user_sessions SET is_active = 0 WHERE user_id/)!.params).toEqual([5]);
  });
});

describe("catalog + settings", () => {
  it("creates a new service type", async () => {
    signIn(fake, { platform_role: "admin" });
    const r = await request(app).post("/api/admin/event-types").set("Cookie", sessionCookie).send({ slug: "plant_swap", name_en: "Plant Swap", name_es: "Intercambio de plantas", uses_draw: false });
    expect(r.status).toBe(201);
  });

  it("only owners can change settings, and only whitelisted keys", async () => {
    signIn(fake, { platform_role: "admin" });
    expect((await request(app).put("/api/admin/settings").set("Cookie", sessionCookie).send({ signups_enabled: "0" })).status).toBe(403);
    fake.reset();
    signIn(fake, { platform_role: "owner" });
    expect((await request(app).put("/api/admin/settings").set("Cookie", sessionCookie).send({ app_version: "9.9.9" })).status).toBe(400);
    expect((await request(app).put("/api/admin/settings").set("Cookie", sessionCookie).send({ signups_enabled: "0" })).status).toBe(200);
  });
});
