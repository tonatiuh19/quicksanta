import { describe, expect, it } from "vitest";
import { gridQueryToParams, parseParticipantLines, platformCan, tenantCan } from "./api";

describe("parseParticipantLines", () => {
  it("parses common formats, dedupes and reports invalid lines", () => {
    const r = parseParticipantLines(
      ["Ana Pérez <ANA@x.com>", "bob@x.com", "Carla, carla@x.com", "Dan;dan@x.com", "Eve\teve@x.com", "ana@x.com", "nope", ""].join("\n"),
    );
    expect(r.valid.map((p) => p.email)).toEqual(["ana@x.com", "bob@x.com", "carla@x.com", "dan@x.com", "eve@x.com"]);
    expect(r.valid[0].name).toBe("Ana Pérez");
    expect(r.valid[1].name).toBe("Bob");
    expect(r.invalid).toEqual(["nope"]);
  });
});

describe("permissions", () => {
  it("only owners manage platform roles and settings", () => {
    expect(platformCan("owner", "users.roles")).toBe(true);
    expect(platformCan("admin", "users.roles")).toBe(false);
    expect(platformCan("admin", "tenants.write")).toBe(true);
    expect(platformCan(null, "overview")).toBe(false);
  });
  it("participants cannot run the draw", () => {
    expect(tenantCan("organizer", "draw.run")).toBe(true);
    expect(tenantCan("participant", "draw.run")).toBe(false);
    expect(tenantCan("participant", "events.view_own")).toBe(true);
  });
});

describe("gridQueryToParams", () => {
  it("drops empty / all filters and blank search", () => {
    expect(gridQueryToParams({ page: 2, limit: 25, sortBy: "name", sortDir: "ASC", q: "  ", filters: { status: "all", plan: "pro" } })).toEqual({
      page: 2,
      limit: 25,
      sort_by: "name",
      sort_dir: "ASC",
      plan: "pro",
    });
  });
});
