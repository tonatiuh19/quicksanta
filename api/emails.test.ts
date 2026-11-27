import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, billingNotices, createServer, EMAIL_PREVIEWS, fmtEmailDate, renderEmail, sendGraceEndedEmails, sendRevealDayEmails, tplInvite } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const H = { "X-Tenant-Id": "7" };
beforeEach(() => {
  fake = installFakeDb();
});

describe("email layout", () => {
  const mail = renderEmail("es", {
    subject: "Hola <b>",
    preheader: "Pre <x>",
    kicker: "K<",
    title: "T <script>",
    blocks: [{ p: "<img src=x onerror=1>" }, { details: [["Nombre", "<i>Ana</i>"], ["Vacío", null], ["Cero", ""]] }, { code: "<1>" }, { quote: "a\n<b>" }, { note: "n<" }],
    cta: { href: "https://quicksanta.com/join/abc?x=1&y=<2>", label: "Ir <ya>" },
    reason: "Porque <sí>",
  });
  it("escapes every user-controlled string (no raw tags from data)", () => {
    for (const raw of ["<b>", "<x>", "<script>", "<img src=x", "<i>Ana", "<1>", "<ya>", "<sí>", "y=<2>"]) expect(mail.html).not.toContain(raw);
    expect(mail.html).toContain("&lt;img src=x onerror=1&gt;");
    expect(mail.html).toContain("a<br>&lt;b&gt;"); // quotes keep line breaks, still escaped
  });
  it("has the pieces good emails need", () => {
    expect(mail.html).toMatch(/^<!doctype html><html lang="es">/);
    expect(mail.html).toContain('name="color-scheme" content="light dark"'); // dark mode
    expect(mail.html).toContain("prefers-color-scheme: dark");
    expect(mail.html).toMatch(/display:none;max-height:0[^>]*>Pre &lt;x&gt;/); // hidden inbox preview line
    expect(mail.html).toContain("v:roundrect"); // Outlook (VML) button
    expect(mail.html).toContain("¿El botón no funciona?"); // copy-the-link fallback
    expect(mail.html).toContain("/icon-192.png"); // real logo, not an emoji
    expect(mail.html).toContain("Disrupting Labs");
    expect(mail.html).not.toMatch(/Vacío|Cero/); // empty detail rows are dropped
  });
  it("plain text mirrors the content: title, blocks, CTA URL, reason", () => {
    expect(mail.text).toContain("T <script>");
    expect(mail.text).toContain("Nombre: <i>Ana</i>");
    expect(mail.text).toContain("Ir <ya>: https://quicksanta.com/join/abc?x=1&y=<2>");
    expect(mail.text).toContain("Porque <sí>");
  });
  it("dates read like dates in each language (UTC, no off-by-one)", () => {
    expect(fmtEmailDate("en", "2026-12-24")).toBe("Thursday, December 24, 2026");
    expect(fmtEmailDate("es", "2026-12-24")).toBe("jueves, 24 de diciembre de 2026");
    expect(fmtEmailDate("en", "2026-12-24 23:30:00")).toBe("Thursday, December 24, 2026");
    expect(fmtEmailDate("en", null)).toBeNull();
    expect(fmtEmailDate("en", "soon")).toBe("soon");
  });
});

describe("every template (gallery samples)", () => {
  const keys = Object.keys(EMAIL_PREVIEWS);
  it("covers every email the app sends", () => {
    expect(keys.sort()).toEqual(
      ["assignment", "assignment_together", "cancel_scheduled", "contact", "invite", "link_joined", "otp", "payment_failed", "pro_ended", "pro_welcome", "resumed", "reminder", "reveal_day"].sort(),
    );
  });
  it.each(keys.flatMap((k) => [[k, "en"], [k, "es"]]) as Array<[string, "en" | "es"]>)("%s (%s) renders cleanly", (k, lang) => {
    const m = EMAIL_PREVIEWS[k](lang);
    expect(m.subject.length).toBeGreaterThan(5);
    expect(m.subject.length).toBeLessThan(90);
    for (const bad of ["undefined", "NaN", "[object Object]", ">null<", ": null"]) {
      expect(m.html).not.toContain(bad);
      expect(m.text).not.toContain(bad);
    }
    if (k !== "contact") expect(EMAIL_PREVIEWS[k]("es").subject).not.toBe(EMAIL_PREVIEWS[k]("en").subject);
  });
  it("invitation shows the exchange as details and a join button", () => {
    const m = tplInvite("en", { organizer: "Olga", eventName: "Office", typeName: "Secret Santa", date: "2026-12-18", budget: "25 USD", people: 14, link: "https://q/join/t" });
    expect(m.subject).toBe("Olga invited you to “Office”");
    expect(m.html).toContain("Friday, December 18, 2026");
    expect(m.text).toContain("Join the exchange: https://q/join/t");
  });
});

describe("billing emails (state transitions, once each)", () => {
  const base = { oldStatus: "incomplete", newStatus: "active", statusFlipped: true, cancelFlipped: false, cancelAtPeriodEnd: false, periodEnd: "2026-12-27 10:00:00", pastDueSince: null, enterprise: false };
  const orgs = () => fake.on(/FROM tenant_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = \? AND m.role = 'organizer'/, [{ email: "olga@x.com", locale: "es" }, { email: "ben@x.com", locale: "en" }]);
  const sent = () => __test.emailDryRuns.map((m) => `${m.to}:${m.template}`);

  it("incomplete → active: Welcome to Pro, to every organizer in their language", async () => {
    orgs();
    await billingNotices(7, "Acme", base);
    expect(sent()).toEqual(["olga@x.com:pro_welcome", "ben@x.com:pro_welcome"]);
    expect(__test.emailDryRuns[0].subject).toContain("Bienvenido a Pro");
    expect(__test.emailDryRuns[1].subject).toContain("Welcome to Pro");
  });
  it("past_due → active (card fixed) is not a second welcome", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, oldStatus: "past_due" });
    expect(sent()).toEqual([]);
  });
  it("active → past_due: payment failed with the grace end date", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, oldStatus: "active", newStatus: "past_due", pastDueSince: "2026-11-27 09:00:00" });
    expect(sent()).toEqual(["olga@x.com:payment_failed", "ben@x.com:payment_failed"]);
    expect(__test.emailDryRuns[1].text).toContain("until Monday, November 30, 2026"); // 3 grace days
  });
  it("not flipped (the other request already handled it) → no email", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, statusFlipped: false });
    await billingNotices(7, "Acme", { ...base, oldStatus: "active", newStatus: "past_due", statusFlipped: false });
    expect(sent()).toEqual([]);
  });
  it("ended after being live → Pro ended, claimed once (shared with the grace cron)", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, oldStatus: "past_due", newStatus: "canceled", pastDueSince: "2026-11-27 09:00:00" });
    expect(sent()).toEqual(["olga@x.com:pro_ended", "ben@x.com:pro_ended"]);
    expect(fake.find(/INSERT IGNORE INTO email_notices/)!.params).toEqual([7, "pro_ended", "7:2026-11-27 09:00:00"]);
    __test.clearEmails();
    fake.once(/INSERT IGNORE INTO email_notices/, { affectedRows: 0, insertId: 0 });
    await billingNotices(7, "Acme", { ...base, oldStatus: "past_due", newStatus: "canceled", pastDueSince: "2026-11-27 09:00:00" });
    expect(sent()).toEqual([]);
  });
  it("enterprise workspaces never get 'back to Free'", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, oldStatus: "active", newStatus: "canceled", enterprise: true });
    expect(sent()).toEqual([]);
  });
  it("cancel scheduled / resumed follow the flag flip", async () => {
    orgs();
    await billingNotices(7, "Acme", { ...base, oldStatus: "active", statusFlipped: false, cancelFlipped: true, cancelAtPeriodEnd: true });
    await billingNotices(7, "Acme", { ...base, oldStatus: "active", statusFlipped: false, cancelFlipped: true, cancelAtPeriodEnd: false });
    expect(sent()).toEqual(["olga@x.com:cancel_scheduled", "ben@x.com:cancel_scheduled", "olga@x.com:resumed", "ben@x.com:resumed"]);
  });
  it("webhook + sync racing: only the request whose compare-and-set flips the status emails", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    orgs();
    fake.on(/SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = \?/, [
      { id: 7, name: "Acme", plan: "free", stripe_subscription_id: "sub_1", subscription_status: "incomplete", cancel_at_period_end: 0 },
    ]);
    fake.once(/UPDATE tenants SET subscription_status = \? WHERE id = \? AND NOT \(subscription_status <=> \?\)/, { affectedRows: 0, insertId: 0 }); // someone else already flipped it
    await __test.syncSubscriptionForTest({ id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, current_period_end: 1798000000, client_secret: null, latest_invoice_id: null, card: null, discount_percent: null, metadata: {} });
    expect(sent().filter((s) => s.endsWith("pro_welcome"))).toEqual([]);
  });
});

describe("reminders", () => {
  const ev = (over: Record<string, unknown> = {}) => [
    { id: 5, public_id: "EV", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", status: "open", plan: "free", currency: "USD", participant_count: 6, joined_count: 2, uses_draw: 1, created_at: "2026-11-01 00:00:00", max_participants_per_event: 20, tenant_plan_raw: "free", subscription_status: "none", ...over },
  ];
  const LOAD = /FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id WHERE e.id = \? AND e.tenant_id = \?/;
  it("emails everyone still invited, with Reply-To the organizer and fresh links", async () => {
    signIn(fake, { email: "olga@x.com", full_name: "Olga" }, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(LOAD, ev());
    fake.on(/SELECT id, email FROM participants WHERE event_id = \? AND tenant_id = \? AND status = 'invited'/, [{ id: 1, email: "a@x.com" }, { id: 2, email: "b@x.com" }]);
    const r = await request(app).post("/api/app/events/5/remind").set("Cookie", sessionCookie).set(H);
    expect(r.body).toMatchObject({ ok: true, reminded: 2, pending: 2 });
    expect(__test.emailDryRuns.map((m) => [m.to, m.template, m.replyTo])).toEqual([
      ["a@x.com", "reminder", "olga@x.com"],
      ["b@x.com", "reminder", "olga@x.com"],
    ]);
    expect(fake.findAll(/UPDATE participants SET invite_token_hash = \?/)).toHaveLength(2);
    expect(fake.find(/INSERT IGNORE INTO email_notices/)!.params.slice(0, 2)).toEqual([7, "remind"]);
  });
  it("once per day; only while open; needs someone to remind; organizers only", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/SELECT id, email FROM participants WHERE event_id = \? AND tenant_id = \? AND status = 'invited'/, [{ id: 1, email: "a@x.com" }]);
    fake.once(LOAD, ev());
    fake.once(/INSERT IGNORE INTO email_notices/, { affectedRows: 0, insertId: 0 });
    expect((await request(app).post("/api/app/events/5/remind").set("Cookie", sessionCookie).set(H)).body.error).toBe("errors.remindedToday");
    fake.once(LOAD, ev({ status: "drawn" }));
    expect((await request(app).post("/api/app/events/5/remind").set("Cookie", sessionCookie).set(H)).body.error).toBe("errors.alreadyDrawn");
    fake.once(LOAD, ev({ status: "pending_payment" }));
    expect((await request(app).post("/api/app/events/5/remind").set("Cookie", sessionCookie).set(H)).body.error).toBe("errors.paymentRequired");
    expect(__test.emailDryRuns).toHaveLength(0);
  });
  it("participants can't send reminders", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "participant" }]);
    expect((await request(app).post("/api/app/events/5/remind").set("Cookie", sessionCookie).set(H)).status).toBe(403);
  });
});

describe("cron emails", () => {
  it("reveal day: each 'together' exchange once, to joined people in their language", async () => {
    fake.on(/WHERE e.reveal_mode = 'together' AND e.status = 'drawn'/, [{ id: 5, tenant_id: 7, public_id: "EV", name: "Gómez", locale: "en" }]);
    fake.on(/FROM participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = \?/, [{ email: "a@x.com", locale: "es" }, { email: "b@x.com", locale: null }]);
    expect(await sendRevealDayEmails()).toBe(2);
    expect(__test.emailDryRuns.map((m) => m.subject)).toEqual([expect.stringContaining("¡Hoy es el día!"), expect.stringContaining("It's reveal day!")]);
    __test.clearEmails();
    fake.on(/INSERT IGNORE INTO email_notices/, { affectedRows: 0, insertId: 0 });
    expect(await sendRevealDayEmails()).toBe(0);
  });
  it("grace ended: Pro-ended once per failed renewal", async () => {
    fake.on(/WHERE subscription_status = 'past_due' AND plan <> 'enterprise'/, [{ id: 7, name: "Acme", past_due_since: "2026-11-20 09:00:00" }]);
    fake.on(/FROM tenant_members m JOIN users u/, [{ email: "olga@x.com", locale: "en" }]);
    expect(await sendGraceEndedEmails()).toBe(1);
    expect(fake.find(/INSERT IGNORE INTO email_notices/)!.params).toEqual([7, "pro_ended", "7:2026-11-20 09:00:00"]);
  });
});

describe("Command Center email gallery", () => {
  it("platform staff only", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    expect((await request(app).get("/api/admin/email-previews").set("Cookie", sessionCookie)).status).toBe(403);
  });
  it("lists, renders EN/ES, rejects unknown/prototype keys", async () => {
    signIn(fake, { platform_role: "admin" });
    const list = await request(app).get("/api/admin/email-previews").set("Cookie", sessionCookie);
    expect(list.body.items.length).toBe(Object.keys(EMAIL_PREVIEWS).length);
    const es = await request(app).get("/api/admin/email-previews/invite?lang=es").set("Cookie", sessionCookie);
    expect(es.body.subject).toContain("te invitó");
    expect(es.body.html).toContain('lang="es"');
    for (const k of ["nope", "__proto__", "constructor", "toString"]) expect((await request(app).get(`/api/admin/email-previews/${k}`).set("Cookie", sessionCookie)).status).toBe(404);
  });
  it("send a test goes only to the signed-in admin", async () => {
    signIn(fake, { email: "admin@quicksanta.com", platform_role: "admin" });
    const r = await request(app).post("/api/admin/email-previews/payment_failed/send").set("Cookie", sessionCookie).send({ lang: "es", to: "victim@x.com" });
    expect(r.body).toMatchObject({ ok: true, to: "admin@quicksanta.com" });
    expect(__test.emailDryRuns.map((m) => [m.to, m.template])).toEqual([["admin@quicksanta.com", "test"]]);
    expect(__test.emailDryRuns[0].subject).toMatch(/^\[Test\] Acción necesaria/);
  });
});
