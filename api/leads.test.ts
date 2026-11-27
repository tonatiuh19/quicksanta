import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer, tplLead } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const good = { name: "Ana Pérez", email: "Ana@Acme.com", company: "Acme", team_size: "100_500", message: "3 offices" };
beforeEach(() => {
  fake = installFakeDb();
});

describe("POST /api/contact (Enterprise form)", () => {
  it("stores the request (email normalized, IP hashed, locale) and emails every active owner", async () => {
    fake.on(/FROM users WHERE platform_role = 'owner'/, [{ email: "alex@disruptinglabs.com" }, { email: "co@disruptinglabs.com" }]);
    const r = await request(app).post("/api/contact").set("Accept-Language", "es").send(good);
    expect(r.status).toBe(201);
    const ins = fake.find(/INSERT INTO contact_requests/)!;
    expect(ins.params.slice(0, 6)).toEqual(["Ana Pérez", "ana@acme.com", "Acme", "100_500", "3 offices", "es"]);
    // Keyed hash (HMAC), not plain sha256(ip), which is brute-forceable over the IPv4 space.
    expect(String(ins.params[6])).toMatch(/^[0-9a-f]{64}$/);
    const ip = "::ffff:127.0.0.1";
    expect(ins.params[6]).not.toBe(require("node:crypto").createHash("sha256").update(ip).digest("hex"));
    expect(ins.params[6]).not.toBe(require("node:crypto").createHash("sha256").update("127.0.0.1").digest("hex"));
    expect(__test.emailDryRuns.map((m) => m.to).sort()).toEqual(["alex@disruptinglabs.com", "co@disruptinglabs.com"]);
    expect(__test.emailDryRuns[0].subject).toBe("New Enterprise inquiry: Acme");
    expect(fake.find(/INSERT INTO audit_log/)).toBeTruthy();
  });

  it("validates name, email and team size", async () => {
    for (const bad of [{ ...good, name: "A" }, { ...good, email: "nope" }, { ...good, team_size: "huge" }, { ...good, message: "x".repeat(2001) }]) {
      expect((await request(app).post("/api/contact").send(bad)).status).toBe(400);
    }
    expect(fake.find(/INSERT INTO contact_requests/)).toBeUndefined();
  });

  it("honeypot: bots get a 201 but nothing is stored or emailed", async () => {
    const r = await request(app).post("/api/contact").send({ ...good, website: "http://spam" });
    expect(r.status).toBe(201);
    expect(fake.find(/INSERT INTO contact_requests/)).toBeUndefined();
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it("the owner email escapes user input", () => {
    const m = tplLead({ name: "<script>x</script>", email: "a@b.co", company: null, teamSize: "lt50", message: "<img src=x>\nhi", link: "https://q/admin/leads" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;img src=x&gt;<br>hi");
  });
});

describe("Command Center → Leads", () => {
  it("requires leads.manage (tenant users are refused)", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    expect((await request(app).get("/api/admin/leads").set("Cookie", sessionCookie)).status).toBe(403);
    expect((await request(app).patch("/api/admin/leads/1").set("Cookie", sessionCookie).send({ status: "won" })).status).toBe(403);
  });

  it("server-side grid: search, filter, sort whitelisted", async () => {
    signIn(fake, { platform_role: "admin" });
    fake.on(/FROM contact_requests c LEFT JOIN users u/, (_p, sql) =>
      /COUNT\(\*\)/.test(sql) ? [{ total: 1 }] : [{ id: 1, name: "Ana", email: "ana@acme.com", company: "Acme", team_size: "100_500", message: null, locale: "es", status: "new", notes: null, handled_by_name: null, created_at: "2026-11-27 10:00:00" }],
    );
    const r = await request(app).get("/api/admin/leads?q=acme&status=new&sort_by=company&sort_dir=ASC").set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ name: "Ana", status: "new", locale: "es" });
    const q = fake.findAll(/FROM contact_requests c/).at(-1)!;
    expect(q.sql).toMatch(/c.status = \?/);
    expect(q.sql).toMatch(/ORDER BY c.company ASC/);
    expect(q.params).toContain("new");
    const bad = await request(app).get("/api/admin/leads?status=hacked&sort_by=password").set("Cookie", sessionCookie);
    expect(bad.status).toBeLessThan(500);
  });

  it("PATCH sets status/notes and records who handled it; unknown id → 404", async () => {
    signIn(fake, { id: 9, platform_role: "owner" });
    const r = await request(app).patch("/api/admin/leads/3").set("Cookie", sessionCookie).send({ status: "contacted", notes: "Call Tue" });
    expect(r.status).toBe(200);
    expect(fake.find(/UPDATE contact_requests SET/)!.params).toEqual([9, "contacted", "Call Tue", 3]);
    fake.once(/UPDATE contact_requests SET/, { affectedRows: 0, insertId: 0 });
    expect((await request(app).patch("/api/admin/leads/404").set("Cookie", sessionCookie).send({ status: "won" })).status).toBe(404);
    expect((await request(app).patch("/api/admin/leads/3").set("Cookie", sessionCookie).send({ status: "maybe" })).status).toBe(400);
  });
});
