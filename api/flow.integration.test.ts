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
    await request(app).put(`/api/app/my/events/${event_public_id}/wishlist`).set("Cookie", ana).send({ wishlist: "Books" }).expect(200);

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
});
