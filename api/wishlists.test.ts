import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer, effectiveWishlists } from "./index";
import { installFakeDb, sessionCookie, signIn, type FakeDb } from "./testFakeDb";

const app = createServer();
let fake: FakeDb;
const type = (slug: string, wishlist_mode: string, over: Record<string, unknown> = {}) => ({
  id: 1, slug, name_en: slug, name_es: slug, description_en: "", description_es: "", icon: "gift", uses_draw: 1, requires_pro: 0, wishlist_mode, is_active: 1, sort_order: 1, ...over,
});
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
const base = { name: "Party", currency: "USD", organizerName: "Org", includeMe: false, exclusions: [], sendInvites: false, participants: people(3) };
const WISH_COL = 20; // allow_wishlists position in the INSERT INTO events params

beforeEach(() => {
  fake = installFakeDb();
});

describe("wishlists are a property of the service", () => {
  it("effectiveWishlists", () => {
    expect(effectiveWishlists("off", true)).toBe(false);
    expect(effectiveWishlists("required", false)).toBe(true);
    expect(effectiveWishlists("optional", false)).toBe(false);
    expect(effectiveWishlists("optional", undefined)).toBe(true);
    expect(effectiveWishlists(undefined, true)).toBe(false);
  });

  it("Secret Santa (Free) never gets wishlists, even if the client asks", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("secret_santa", "off")]);
    await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "secret_santa", allowWishlists: true });
    expect(fake.find(/INSERT INTO events/)!.params[WISH_COL]).toBe(0);
  });

  it("Wishlist Exchange always has wishlists, even if the client turns them off", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("wishlist_exchange", "required", { requires_pro: 1 })]);
    await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "wishlist_exchange", allowWishlists: false });
    expect(fake.find(/INSERT INTO events/)!.params[WISH_COL]).toBe(1);
  });

  it("optional services follow the organizer's choice", async () => {
    signIn(fake);
    fake.on(/FROM event_types WHERE slug = \?/, [type("book_swap", "optional", { requires_pro: 1 })]);
    await request(app).post("/api/wizard/launch").set("Cookie", sessionCookie).send({ ...base, eventTypeSlug: "book_swap", allowWishlists: false });
    expect(fake.find(/INSERT INTO events/)!.params[WISH_COL]).toBe(0);
  });

  it("PATCH can't switch wishlists on a fixed service", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [
      { id: 5, public_id: "E", tenant_id: 7, event_type_slug: "secret_santa", name: "X", status: "open", currency: "USD", allow_wishlists: 0, wishlist_mode: "off", uses_draw: 1, reveal_mode: "private", participant_count: 3, max_participants_per_event: 20, tenant_plan_raw: "free" },
    ]);
    const r = await request(app).patch("/api/app/events/5").set("Cookie", sessionCookie).send({ allow_wishlists: true });
    expect(r.body.error).toBe("errors.wishlistsFixed");
  });

  it("legacy events on an 'off' service can still switch wishlists off", async () => {
    signIn(fake, {}, [{ tenant_id: 7, role: "organizer" }]);
    fake.on(/FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t/, [
      { id: 5, public_id: "E", tenant_id: 7, event_type_slug: "secret_santa", name: "X", status: "open", currency: "USD", allow_wishlists: 1, wishlist_mode: "off", uses_draw: 1, reveal_mode: "private", participant_count: 3, max_participants_per_event: 20, tenant_plan_raw: "free" },
    ]);
    expect((await request(app).patch("/api/app/events/5").set("Cookie", sessionCookie).send({ allow_wishlists: false })).status).toBe(200);
  });
});
