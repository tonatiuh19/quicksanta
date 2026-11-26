import { describe, expect, it } from "vitest";
import { makeStore } from "@/store";
import { logout, sessionExpired, switchTenant } from "@/store/slices/authSlice";
import { grids } from "@/store/slices/grids";
import { patchDraft } from "@/store/slices/wizardSlice";

function dirty() {
  const s = makeStore();
  s.dispatch({ type: "auth/me/fulfilled", payload: { id: 1, email: "a@x.com", memberships: [], active_tenant_id: 7 } });
  s.dispatch({ type: "app/billing/fulfilled", payload: { plan: "pro", card: { last4: "4242" } } });
  s.dispatch({ type: "app/dashboard/fulfilled", payload: { tenant: { id: 7 } } });
  s.dispatch(grids.adminTenants.actions.setSearch("acme"));
  s.dispatch({ type: "catalog/fetch/fulfilled", payload: [{ slug: "secret_santa" }] });
  s.dispatch(patchDraft({ name: "Secret party", participants: [{ name: "Ana", email: "ana@x.com" }] }));
  return s;
}

describe("store reset", () => {
  it("logout wipes every session/workspace slice (incl. the wizard draft + localStorage) but keeps the catalog", () => {
    const s = dirty();
    s.dispatch({ type: logout.fulfilled.type });
    const st = s.getState();
    expect(st.auth.user).toBeNull();
    expect(st.app.billing).toBeNull();
    expect(st.app.dashboard).toBeNull();
    expect(st.adminTenants.query.q).toBe("");
    expect(st.wizard.draft.name).toBe("");
    expect(st.wizard.draft.participants).toEqual([]);
    expect(localStorage.getItem("qs_wizard_draft")).toBeNull();
    expect(st.catalog.items).toHaveLength(1);
  });

  it("session expiry behaves like logout", () => {
    const s = dirty();
    s.dispatch(sessionExpired());
    expect(s.getState().app.billing).toBeNull();
    expect(s.getState().wizard.draft.name).toBe("");
  });

  it("switching workspace clears workspace data + grids but keeps the user and the wizard draft", () => {
    const s = dirty();
    s.dispatch({ type: switchTenant.fulfilled.type, payload: 8 });
    const st = s.getState();
    expect(st.auth.user?.active_tenant_id).toBe(8);
    expect(st.app.billing).toBeNull();
    expect(st.app.dashboard).toBeNull();
    expect(st.adminTenants.query.q).toBe("");
    expect(st.wizard.draft.name).toBe("Secret party");
  });
});

describe("grid page clamp", () => {
  it("an empty page past the end snaps back to the last page", () => {
    const s = makeStore();
    const g = grids.appParticipants;
    s.dispatch(g.actions.setPage(3));
    s.dispatch({ type: g.fetch.pending.type, meta: { requestId: "r1" } });
    s.dispatch({ type: g.fetch.fulfilled.type, meta: { requestId: "r1" }, payload: { items: [], pagination: { page: 3, limit: 50, total: 60, totalPages: 2 } } });
    expect(s.getState().appParticipants.query.page).toBe(2);
  });
  it("reset() forgets rows and query (switching exchanges)", () => {
    const s = makeStore();
    const g = grids.appParticipants;
    s.dispatch(g.actions.setSearch("ana"));
    s.dispatch({ type: g.fetch.pending.type, meta: { requestId: "r1" } });
    s.dispatch({ type: g.fetch.fulfilled.type, meta: { requestId: "r1" }, payload: { items: [{ id: 1 }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } } });
    s.dispatch(g.actions.reset());
    expect(s.getState().appParticipants.items).toEqual([]);
    expect(s.getState().appParticipants.query.q).toBe("");
  });
});
