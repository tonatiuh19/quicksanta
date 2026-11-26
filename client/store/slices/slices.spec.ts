import { describe, expect, it } from "vitest";
import { makeStore } from "@/store";
import { grids } from "./grids";
import { addExclusion, addParticipants, patchDraft, removeParticipant } from "./wizardSlice";

describe("grid slice", () => {
  it("toggleSort / setFilter / setSearch reset to page 1", () => {
    const s = makeStore();
    const a = grids.adminTenants.actions;
    s.dispatch(a.setPage(4));
    s.dispatch(a.toggleSort("name"));
    expect(s.getState().adminTenants.query).toMatchObject({ page: 1, sortBy: "name", sortDir: "ASC" });
    s.dispatch(a.toggleSort("name"));
    expect(s.getState().adminTenants.query.sortDir).toBe("DESC");
    s.dispatch(a.setPage(3));
    s.dispatch(a.setFilter({ key: "status", value: "active" }));
    expect(s.getState().adminTenants.query).toMatchObject({ page: 1, filters: { status: "active" } });
    s.dispatch(a.setPage(2));
    s.dispatch(a.setSearch("x"));
    expect(s.getState().adminTenants.query.page).toBe(1);
  });
});

describe("wizard slice", () => {
  it("dedupes participants and drops a removed person's exclusions (rules reference emails, not positions)", () => {
    const s = makeStore();
    s.dispatch(patchDraft({ includeMe: true, participants: [], exclusions: [] }));
    s.dispatch(addParticipants([{ name: "A", email: "a@x.com" }, { name: "B", email: "b@x.com" }, { name: "C", email: "c@x.com" }, { name: "A2", email: "a@x.com" }]));
    expect(s.getState().wizard.draft.participants).toHaveLength(3);
    s.dispatch(addExclusion({ a: "a@x.com", b: "b@x.com", bidirectional: true }));
    s.dispatch(addExclusion({ a: "b@x.com", b: "c@x.com", bidirectional: false }));
    s.dispatch(addExclusion({ a: "b@x.com", b: "a@x.com", bidirectional: true })); // duplicate of the first (bidirectional)
    s.dispatch(addExclusion({ a: "me", b: "c@x.com", bidirectional: true }));
    expect(s.getState().wizard.draft.exclusions).toHaveLength(3);
    s.dispatch(removeParticipant("a@x.com"));
    expect(s.getState().wizard.draft.exclusions).toEqual([
      { a: "b@x.com", b: "c@x.com", bidirectional: false },
      { a: "me", b: "c@x.com", bidirectional: true },
    ]);
  });
});
