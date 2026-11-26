import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStore } from "@/store";
import { mockApi, user } from "@/test/render";
import { sessionExpired, logout } from "@/store/slices/authSlice";
import { DRAFT_SAVE_DEBOUNCE_MS } from "@/store/draftSync";
import { addParticipants, clampStep, draftHasContent, emptyDraft, goTo, loadDraft, patchDraft, resetWizard, sanitizeDraft, utcIso } from "@/store/slices/wizardSlice";

const KEY = "qs_wizard_draft";
const stored = () => JSON.parse(localStorage.getItem(KEY) || "null");
const signedIn = () => {
  const s = makeStore();
  s.dispatch({ type: "auth/me/fulfilled", payload: user() });
  return s;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("draft helpers", () => {
  it("only real work counts as a draft (not the auto-filled organizer name or a service pick)", () => {
    expect(draftHasContent({ ...emptyDraft(), organizerName: "Alex", eventTypeSlug: "book_swap" })).toBe(false);
    expect(draftHasContent({ ...emptyDraft(), name: "Party" })).toBe(true);
    expect(draftHasContent(emptyDraft(), "details")).toBe(true);
  });
  it("sanitizes untrusted JSON", () => {
    const d = sanitizeDraft({ name: 5, participants: [{ email: "a@x.com", name: "A" }, null, { name: "no email" }], exclusions: "x", custom: null });
    expect(d.name).toBe("");
    expect(d.participants).toEqual([{ email: "a@x.com", name: "A" }]);
    expect(d.exclusions).toEqual([]);
    expect(d.custom?.icon).toBe("sparkles");
    expect(sanitizeDraft([1, 2])).toEqual(emptyDraft());
  });
  it("clamps a skipped step to the closest earlier one", () => {
    expect(clampStep("account", ["service", "details", "people", "rules", "review"])).toBe("rules");
    expect(clampStep("rules", ["service", "details", "people", "review"])).toBe("people");
    expect(clampStep("people", ["service", "details", "people", "review"])).toBe("people");
  });
  it("reads DB UTC datetimes", () => {
    expect(utcIso("2026-11-26 10:00:00")).toBe("2026-11-26T10:00:00.000Z");
  });
  it("loads v1 drafts, and drops drafts older than 30 days", () => {
    localStorage.setItem(KEY, JSON.stringify({ ...emptyDraft(), name: "Legacy" }));
    expect(loadDraft().draft.name).toBe("Legacy");
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    localStorage.setItem(KEY, JSON.stringify({ v: 2, draft: { ...emptyDraft(), name: "Old" }, step: "people", savedAt: old }));
    expect(loadDraft().draft.name).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("signed out: browser only", () => {
  it("persists draft + step + savedAt, and a reload asks to resume", () => {
    const calls = mockApi({});
    const s = makeStore();
    s.dispatch(patchDraft({ name: "Family" }));
    s.dispatch(goTo("people"));
    expect(stored()).toMatchObject({ v: 2, step: "people", draft: { name: "Family" } });
    expect(s.getState().wizard.savedAt).toBeTruthy();
    expect(calls.filter((c) => c.url === "/wizard/draft")).toEqual([]);
    const reloaded = makeStore().getState().wizard;
    expect(reloaded).toMatchObject({ step: "people", resumePending: true, draft: { name: "Family" } });
  });

  it("regression: the signed-out 401 on /auth/me does not wipe the draft", () => {
    const s = makeStore();
    s.dispatch(patchDraft({ name: "Family" }));
    s.dispatch(sessionExpired());
    expect(s.getState().wizard.draft.name).toBe("Family");
    expect(stored().draft.name).toBe("Family");
  });

  it("an untouched draft is never stored", () => {
    const s = makeStore();
    s.dispatch(patchDraft({ organizerName: "Alex" }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("signed in: browser + account", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("autosaves to the account, debounced (one PUT per burst)", async () => {
    const calls = mockApi({ get: { "/wizard/draft": { draft: null } }, put: { "/wizard/draft": { ok: true } } });
    const s = signedIn();
    s.dispatch(patchDraft({ name: "O" }));
    s.dispatch(patchDraft({ name: "Office" }));
    s.dispatch(addParticipants([{ name: "Ana", email: "ana@x.com" }]));
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DEBOUNCE_MS + 50);
    const puts = calls.filter((c) => c.method === "put");
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(puts.at(-1)!.body).toMatchObject({ step: "service", data: { name: "Office", participants: [{ email: "ana@x.com" }] } });
    expect(puts.filter((p) => p.body.data.name === "O")).toEqual([]);
  });

  it("on sign-in, a browser draft moves into the account", async () => {
    const calls = mockApi({ get: { "/wizard/draft": { draft: null } }, put: { "/wizard/draft": { ok: true } } });
    const s = makeStore();
    s.dispatch(patchDraft({ name: "Started signed out" }));
    s.dispatch({ type: "auth/verifyOtp/fulfilled", payload: user() });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.find((c) => c.method === "put")?.body.data.name).toBe("Started signed out");
  });

  it("on sign-in, a newer account draft replaces an empty/older browser one and asks to resume", async () => {
    mockApi({ get: { "/wizard/draft": { draft: { step: "people", data: { name: "From laptop" }, updated_at: "2099-01-01 00:00:00" } } }, put: { "/wizard/draft": { ok: true } } });
    const s = makeStore();
    s.dispatch({ type: "auth/me/fulfilled", payload: user() });
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(s.getState().wizard).toMatchObject({ step: "people", resumePending: true, draft: { name: "From laptop" } });
    expect(stored().draft.name).toBe("From laptop");
  });

  it("a background /auth/me refresh with the same draft on both sides neither re-saves nor pops the resume screen (clock skew)", async () => {
    const draft = { ...emptyDraft(), name: "Same" };
    const calls = mockApi({ get: { "/wizard/draft": { draft: { step: "people", data: draft, updated_at: "2099-01-01 00:00:00" } } }, put: { "/wizard/draft": { ok: true } } });
    const s = makeStore();
    s.dispatch(patchDraft({ name: "Same" }));
    s.dispatch(goTo("people"));
    s.dispatch({ type: "wizard/resumeDraft" });
    s.dispatch({ type: "auth/me/fulfilled", payload: user() });
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DEBOUNCE_MS + 50);
    expect(s.getState().wizard.resumePending).toBe(false);
    expect(calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it("an explicit reset deletes the account copy; logout keeps it (clears only the browser)", async () => {
    const calls = mockApi({ get: { "/wizard/draft": { draft: null } }, put: { "/wizard/draft": { ok: true } }, delete: { "/wizard/draft": { ok: true } }, post: { "/auth/logout": { ok: true } } });
    const s = signedIn();
    s.dispatch(patchDraft({ name: "Office" }));
    s.dispatch(resetWizard());
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c.method === "delete" && c.url === "/wizard/draft")).toHaveLength(1);

    s.dispatch(patchDraft({ name: "Again" }));
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DEBOUNCE_MS + 50);
    s.dispatch({ type: logout.fulfilled.type });
    await vi.advanceTimersByTimeAsync(10);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(calls.filter((c) => c.method === "delete")).toHaveLength(1);
  });
});
