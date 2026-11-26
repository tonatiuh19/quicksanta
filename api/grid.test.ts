import { describe, expect, it } from "vitest";
import { likeContains, paginationInfo, parseGridQuery, type GridSpec } from "./index";

const SPEC: GridSpec = {
  sortMap: { id: "t.id", name: "t.name", created_at: "t.created_at" },
  defaultSort: "created_at",
  filters: { status: { column: "t.status", values: ["active", "suspended"] } },
  search: ["t.name", "u.email"],
};

describe("parseGridQuery", () => {
  it("defaults page/limit/sort and adds a stable id tiebreaker", () => {
    const g = parseGridQuery({}, SPEC);
    expect(g).toMatchObject({ page: 1, limit: 25, offset: 0, orderBy: "t.created_at DESC, t.id DESC", where: [], params: [] });
  });

  it("clamps limit and page, computes offset", () => {
    expect(parseGridQuery({ page: "3", limit: "500" }, SPEC)).toMatchObject({ page: 3, limit: 100, offset: 200 });
    expect(parseGridQuery({ page: "-4", limit: "0" }, SPEC)).toMatchObject({ page: 1, limit: 1 });
    expect(parseGridQuery({ page: "abc" }, SPEC).page).toBe(1);
  });

  it("only sorts by whitelisted keys (SQL injection safe)", () => {
    expect(parseGridQuery({ sort_by: "name", sort_dir: "asc" }, SPEC).orderBy).toBe("t.name ASC, t.id ASC");
    expect(parseGridQuery({ sort_by: "name; DROP TABLE users", sort_dir: "sideways" }, SPEC).orderBy).toBe("t.created_at DESC, t.id DESC");
  });

  it("applies whitelisted filters and ignores unknown values / 'all'", () => {
    expect(parseGridQuery({ status: "active" }, SPEC)).toMatchObject({ where: ["t.status = ?"], params: ["active"] });
    expect(parseGridQuery({ status: "deleted" }, SPEC).where).toEqual([]);
    expect(parseGridQuery({ status: "all" }, SPEC).where).toEqual([]);
  });

  it("searches across columns with escaped LIKE and keeps base scope first", () => {
    const g = parseGridQuery({ q: "50%_off!" }, SPEC, ["t.tenant_id = ?"], [7]);
    expect(g.where).toEqual(["t.tenant_id = ?", "(t.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!')"]);
    expect(g.params).toEqual([7, "%50!%!_off!!%", "%50!%!_off!!%"]);
  });
});

describe("helpers", () => {
  it("likeContains trims, caps and returns null for blank", () => {
    expect(likeContains("  ")).toBeNull();
    expect(likeContains("x".repeat(200))!.length).toBe(82);
  });
  it("paginationInfo", () => {
    expect(paginationInfo(parseGridQuery({ limit: "10" }, SPEC), 31)).toEqual({ page: 1, limit: 10, total: 31, totalPages: 4 });
    expect(paginationInfo(parseGridQuery({}, SPEC), 0).totalPages).toBe(1);
  });
});
