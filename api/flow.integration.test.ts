/**
 * End-to-end against the real shared TiDB: OTP signup → wizard launch → join → draw → reveal → admin grid.
 * Run: npm run test:integration (needs DB_* in .env and migrations applied).
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { __test, createServer } from "./index";
import { cleanupByPrefix, createIntegrationTestPool, fixturePrefix } from "./testDbCleanup";

const HAS_DB = Boolean(process.env.DB_HOST);
const prefix = fixturePrefix("flow");
const mail = (n: string) => `${prefix}${n}@example.com`;
const app = createServer();

async function login(email: string, name: string) {
  __test.clearEmails();
  const r1 = await request(app).post("/api/auth/otp/request").send({ email });
  expect(r1.status).toBe(200);
  const code = __test.emailDryRuns.find((m) => m.to === email)!.text.match(/\d{6}/)![0];
  const r2 = await request(app).post("/api/auth/otp/verify").send({ email, code, full_name: name });
  expect(r2.status).toBe(200);
  return String(r2.headers["set-cookie"]).match(/qs_sid=[^;]+/)![0];
}

describe.skipIf(!HAS_DB)("full flow (TiDB)", () => {
  const pool = HAS_DB ? createIntegrationTestPool() : null;
  beforeAll(() => __test.setDb(null));
  afterAll(async () => {
    if (pool) {
      await cleanupByPrefix(pool, prefix);
      await pool.end();
    }
    await __test.closePool();
  });

  it("organizer launches, participants join, draw assigns everyone", async () => {
    const org = await login(mail("org"), "Org Person");
    __test.clearEmails();
    const launch = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", org)
      .send({
        eventTypeSlug: "secret_santa",
        name: "Integration Santa",
        currency: "USD",
        budgetMin: 10,
        budgetMax: 20,
        allowWishlists: true,
        organizerName: "Org Person",
        includeMe: true,
        participants: [
          { name: "Ana", email: mail("ana") },
          { name: "Bob", email: mail("bob") },
          { name: "Cy", email: mail("cy") },
        ],
        exclusions: [{ a: mail("ana"), b: mail("bob"), bidirectional: true }],
        sendInvites: true,
      });
    expect(launch.status).toBe(201);
    const { event_id, event_public_id, tenant_id } = launch.body;
    const tokens = __test.emailDryRuns.filter((m) => m.template === "invite").map((m) => ({ to: m.to, token: m.text.match(/\/join\/([A-Za-z0-9_-]+)/)![1] }));
    expect(tokens).toHaveLength(3);

    // Ana joins with her own account.
    const ana = await login(mail("ana"), "Ana");
    const anaTok = tokens.find((t) => t.to === mail("ana"))!.token;
    expect((await request(app).get(`/api/join/${anaTok}`)).body.invite.event_name).toBe("Integration Santa");
    expect((await request(app).post(`/api/join/${anaTok}/respond`).set("Cookie", ana).send({ accept: true })).body.status).toBe("joined");
    // Secret Santa has no wishlists (service setting), even though the launch asked for them.
    await request(app).put(`/api/app/my/events/${event_public_id}/wishlist`).set("Cookie", ana).send({ wishlist: "Books" }).expect(404);

    // Ana (participant) cannot run the draw.
    expect((await request(app).post(`/api/app/events/${event_id}/draw`).set("Cookie", ana).set("X-Tenant-Id", String(tenant_id))).status).toBe(403);

    // Organizer grid sees 4 participants.
    const grid = await request(app).get(`/api/app/events/${event_id}/participants`).query({ sort_by: "name", sort_dir: "ASC", limit: 2 }).set("Cookie", org);
    expect(grid.body.pagination).toMatchObject({ total: 4, totalPages: 2 });

    const draw = await request(app).post(`/api/app/events/${event_id}/draw`).set("Cookie", org).send({});
    expect(draw.status).toBe(200);
    expect(draw.body.assigned).toBe(4);

    const mine = await request(app).get(`/api/app/my/events/${event_public_id}`).set("Cookie", ana);
    expect(mine.body.receiver?.name).toBeTruthy();
    expect(mine.body.receiver.name).not.toBe("Ana");
    expect(mine.body.receiver.name).not.toBe("Bob"); // excluded pair
  });

  it("wizard draft: upsert (one per user), read back, launch deletes it", async () => {
    const me = await login(mail("drafter"), "Drafter");
    expect((await request(app).get("/api/wizard/draft").set("Cookie", me)).body.draft).toBeNull();
    await request(app).put("/api/wizard/draft").set("Cookie", me).send({ step: "details", data: { name: "First" } }).expect(200);
    await request(app).put("/api/wizard/draft").set("Cookie", me).send({ step: "people", data: { name: "Second", participants: [{ name: "Ñu", email: mail("nu") }] } }).expect(200);
    const got = (await request(app).get("/api/wizard/draft").set("Cookie", me)).body.draft;
    expect(got).toMatchObject({ step: "people", data: { name: "Second", participants: [{ name: "Ñu" }] } });
    expect(got.updated_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    const launch = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", me)
      .send({ eventTypeSlug: "white_elephant", name: "Draft party", currency: "USD", organizerName: "Drafter", includeMe: true, participants: [{ name: "Nu", email: mail("nu") }], exclusions: [], sendInvites: false });
    expect(launch.status).toBe(201);
    expect((await request(app).get("/api/wizard/draft").set("Cookie", me)).body.draft).toBeNull();
  });

  it("invite link: enable, preview, join (cap + plan + concurrency), regenerate kills the old code", async () => {
    const org = await login(mail("linkorg"), "Link Org");
    const launch = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", org)
      .send({ eventTypeSlug: "secret_santa", name: "Link party", currency: "USD", organizerName: "Link Org", includeMe: true, participants: [{ name: "Em", email: mail("em") }, { name: "Fi", email: mail("fi") }], exclusions: [], sendInvites: false });
    expect(launch.status).toBe(201);
    const ev = launch.body.event_id;
    const on = await request(app).put(`/api/app/events/${ev}/invite-link`).set("Cookie", org).send({ enabled: true, max: 2 });
    expect(on.status).toBe(200);
    const code: string = on.body.link.code;
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

    expect((await request(app).get(`/api/join-code/${code.toLowerCase()}`)).body.preview).toMatchObject({ event_name: "Link party", people: 3, state: "open" });

    // Em was invited by email: joining with the link accepts her invite (no new seat, not via link).
    const em = await login(mail("em"), "Em");
    expect((await request(app).post(`/api/join-code/${code}`).set("Cookie", em).send({})).body).toMatchObject({ status: "joined", already: false });

    // Three strangers race for a link capped at 2 → exactly 2 get in.
    const strangers = await Promise.all(["s1", "s2", "s3"].map((n) => login(mail(n), n.toUpperCase())));
    const results = await Promise.all(strangers.map((c) => request(app).post(`/api/join-code/${code}`).set("Cookie", c).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error)).toEqual(["errors.joinFull"]);

    const info = (await request(app).get(`/api/app/events/${ev}/invite-link`).set("Cookie", org)).body.link;
    expect(info).toMatchObject({ joined_via_link: 2, state: "full" });
    const viaLink = await request(app).get(`/api/app/events/${ev}/participants?joined_via=link`).set("Cookie", org);
    expect(viaLink.body.items.map((p: any) => p.joined_via)).toEqual(["link", "link"]);

    const regen = await request(app).post(`/api/app/events/${ev}/invite-link/regenerate`).set("Cookie", org);
    expect(regen.body.link.code).not.toBe(code);
    expect((await request(app).get(`/api/join-code/${code}`)).status).toBe(404);
  });

  it("concurrency: a draw racing link joins leaves nobody without a match; organizer adds can't overfill past link joins", async () => {
    const org = await login(mail("raceorg"), "Race Org");
    const launch = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", org)
      .send({ eventTypeSlug: "secret_santa", name: "Race party", currency: "USD", organizerName: "Race Org", includeMe: true, participants: [{ name: "R1", email: mail("r1") }, { name: "R2", email: mail("r2") }], exclusions: [], sendInvites: false });
    const ev = launch.body.event_id;
    const code = (await request(app).put(`/api/app/events/${ev}/invite-link`).set("Cookie", org).send({ enabled: true })).body.link.code;
    const joiners = await Promise.all(["rj1", "rj2", "rj3"].map((n) => login(mail(n), n.toUpperCase())));

    const [draw, ...joins] = await Promise.all([
      request(app).post(`/api/app/events/${ev}/draw`).set("Cookie", org).send({}),
      ...joiners.map((c) => request(app).post(`/api/join-code/${code}`).set("Cookie", c).send({})),
    ]);
    expect(draw.status).toBe(200);
    for (const j of joins) expect([200, 409]).toContain(j.status);
    // Invariant: once drawn, every active person gives exactly one gift.
    const p = pool!;
    const [[active], [givers], [link]] = await Promise.all([
      p.query("SELECT id FROM participants WHERE event_id = ? AND status IN ('invited','joined')", [ev]),
      p.query("SELECT giver_participant_id AS id FROM assignments WHERE event_id = ?", [ev]),
      p.query("SELECT join_enabled FROM events WHERE id = ?", [ev]),
    ]) as any;
    expect(givers.map((g: any) => Number(g.id)).sort()).toEqual(active.map((a: any) => Number(a.id)).sort());
    expect(Number(link[0].join_enabled)).toBe(0); // the draw switched the link off

    // Plan limit under a mixed race: 17 free seats left on a Free exchange (20), link joins + an organizer bulk add.
    const launch2 = await request(app)
      .post("/api/wizard/launch")
      .set("Cookie", org)
      .send({ eventTypeSlug: "secret_santa", name: "Limit party", currency: "USD", organizerName: "Race Org", includeMe: true, participants: [{ name: "L1", email: mail("l1") }, { name: "L2", email: mail("l2") }], exclusions: [], sendInvites: false });
    const ev2 = launch2.body.event_id;
    const code2 = (await request(app).put(`/api/app/events/${ev2}/invite-link`).set("Cookie", org).send({ enabled: true })).body.link.code;
    const bulk = Array.from({ length: 16 }, (_, i) => ({ name: `B${i}`, email: mail(`b${i}`) })); // 3 + 16 = 19
    const linkers = await Promise.all(["lk1", "lk2", "lk3"].map((n) => login(mail(n), n.toUpperCase())));
    await Promise.all([
      request(app).post(`/api/app/events/${ev2}/participants`).set("Cookie", org).send({ participants: bulk, send_invites: false }),
      ...linkers.map((c) => request(app).post(`/api/join-code/${code2}`).set("Cookie", c).send({})),
    ]);
    const [[cnt]] = (await p.query("SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status IN ('invited','joined')", [ev2])) as any;
    expect(Number(cnt.n)).toBeLessThanOrEqual(20);
  });
});
