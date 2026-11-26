import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer, sha256 } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
beforeEach(() => {
  fake = installFakeDb();
});

describe("POST /api/auth/otp/request", () => {
  it("rejects invalid emails", async () => {
    const r = await request(app).post("/api/auth/otp/request").send({ email: "nope" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation.invalid");
  });

  it("stores a hashed code and emails it (new user = signup)", async () => {
    const r = await request(app).post("/api/auth/otp/request").send({ email: "New@Example.com" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, sent: true }); // no is_new: never reveal whether an account exists
    const ins = fake.find(/INSERT INTO otp_codes/)!;
    expect(ins.params[0]).toBe("new@example.com");
    const mail = __test.emailDryRuns[0];
    const code = mail.text.match(/\d{6}/)![0];
    expect(ins.params[1]).toBe(sha256(code));
    expect(ins.params[1]).not.toBe(code);
  });

  it("does not reveal suspended accounts (same answer, no code)", async () => {
    fake.on(/SELECT id, status FROM users WHERE email/, [{ id: 3, status: "suspended" }]);
    const r = await request(app).post("/api/auth/otp/request").send({ email: "s@example.com" });
    expect(r.body).toEqual({ ok: true, sent: true });
    expect(fake.find(/INSERT INTO otp_codes/)).toBeUndefined();
    expect(__test.emailDryRuns).toHaveLength(0);
  });

  it("burns the code and returns 502 when email delivery fails", async () => {
    __test.setEmailTransport(async () => {
      throw new Error("down");
    });
    const r = await request(app).post("/api/auth/otp/request").send({ email: "a@example.com" });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("errors.otpSendFailed");
    expect(fake.find(/UPDATE otp_codes SET consumed_at/)).toBeTruthy();
  });
});

describe("POST /api/auth/otp/verify", () => {
  const otpRow = (attempts = 0) => [{ id: 5, code_hash: sha256("123456"), attempts }];

  it("rejects when there is no live code", async () => {
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("errors.otpInvalid");
  });

  it("counts wrong attempts and reports attempts left", async () => {
    fake.on(/FROM otp_codes WHERE email/, otpRow(1));
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "000000" });
    expect(r.status).toBe(400);
    expect(r.body.attempts_left).toBe(3);
    expect(fake.find(/SET attempts = attempts \+ 1/)).toBeTruthy();
  });

  it("locks after 5 attempts", async () => {
    fake.on(/FROM otp_codes WHERE email/, otpRow(5));
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456" });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("errors.authLocked");
  });

  it("fails if the atomic consume loses a race", async () => {
    fake.on(/FROM otp_codes WHERE email/, otpRow());
    fake.on(/UPDATE otp_codes SET consumed_at = UTC_TIMESTAMP\(\), attempts = GREATEST/, { affectedRows: 0, insertId: 0 });
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456" });
    expect(r.status).toBe(400);
    expect(fake.find(/INSERT INTO user_sessions/)).toBeUndefined();
  });

  it("creates the user on first login and sets an HttpOnly session cookie", async () => {
    fake.on(/FROM otp_codes WHERE email/, otpRow());
    fake.once(/SELECT id, status FROM users WHERE email/, []);
    fake.on(/SELECT id, status FROM users WHERE email/, [{ id: 42, status: "active" }]);
    const r = await request(app).post("/api/auth/otp/verify").send({ email: "a@example.com", code: "123456", full_name: "Ana" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, is_new: true });
    expect(fake.find(/INSERT INTO users/)!.params.slice(1, 3)).toEqual(["a@example.com", "Ana"]);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/qs_sid=[a-f0-9]{64}/);
    expect(cookie).toContain("HttpOnly");
    // Only the hash is stored.
    const token = cookie.match(/qs_sid=([a-f0-9]{64})/)![1];
    expect(fake.find(/INSERT INTO user_sessions/)!.params[1]).toBe(sha256(token));
  });
});

describe("session endpoints", () => {
  it("GET /me is 401 without a cookie", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });

  it("GET /me returns the user with memberships", async () => {
    signIn(fake, { platform_role: "owner" }, [{ tenant_id: 7, role: "organizer" }]);
    const r = await request(app).get("/api/auth/me").set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: 1, platform_role: "owner", active_tenant_id: 7, memberships: [{ tenant_id: 7, role: "organizer" }] });
    expect(r.body.user.session_id).toBeUndefined();
  });

  it("switch-tenant only to tenants you belong to", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).post("/api/auth/switch-tenant").set("Cookie", sessionCookie).send({ tenant_id: 8 })).status).toBe(403);
    expect((await request(app).post("/api/auth/switch-tenant").set("Cookie", sessionCookie).send({ tenant_id: 7 })).status).toBe(200);
  });

  it("logout deactivates the session and clears the cookie", async () => {
    const r = await request(app).post("/api/auth/logout").set("Cookie", sessionCookie);
    expect(r.status).toBe(200);
    expect(fake.find(/UPDATE user_sessions SET is_active = 0/)).toBeTruthy();
    expect(String(r.headers["set-cookie"])).toContain("Expires=Thu, 01 Jan 1970");
  });
});

describe("CSRF origin guard", () => {
  it("blocks cross-site writes", async () => {
    const r = await request(app).post("/api/auth/logout").set("Origin", "https://evil.example.net");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("errors.badOrigin");
  });
  it("allows localhost", async () => {
    expect((await request(app).post("/api/auth/logout").set("Origin", "http://localhost:8080")).status).toBe(200);
  });
});

describe("misc", () => {
  it("health + unknown route + bad JSON", async () => {
    expect((await request(app).get("/api/health")).body.ok).toBe(true);
    expect((await request(app).get("/api/nope")).status).toBe(404);
    const bad = await request(app).post("/api/auth/otp/request").set("Content-Type", "application/json").send("{bad");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("validation.invalidJson");
  });
  it("lists active event types", async () => {
    fake.on(/FROM event_types WHERE is_active = 1/, [{ id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "", description_es: "", icon: "gift", uses_draw: 1, is_active: 1, sort_order: 10 }]);
    const r = await request(app).get("/api/event-types");
    expect(r.body.items[0]).toMatchObject({ slug: "secret_santa", uses_draw: true });
  });
});
