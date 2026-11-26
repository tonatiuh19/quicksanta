import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import Wizard from "@/pages/public/Wizard";
import Dashboard from "@/pages/app/Dashboard";
import { emptyDraft } from "@/store/slices/wizardSlice";
import { mockApi, renderApp, user } from "@/test/render";
import { relativeTime } from "./DraftCard";

const TYPES = {
  ok: true,
  items: [{ id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "Draw", description_es: "", icon: "gift", uses_draw: true, wishlist_mode: "off", is_active: true, sort_order: 1 }],
};
const saveLocal = (over: object, step = "people") =>
  localStorage.setItem(
    "qs_wizard_draft",
    JSON.stringify({ v: 2, step, savedAt: new Date(Date.now() - 5 * 60_000).toISOString(), draft: { ...emptyDraft(), name: "Family 2026", organizerName: "Alex", participants: [{ name: "Ana", email: "ana@x.com" }, { name: "Bo", email: "bo@x.com" }], ...over } }),
  );

describe("drafts UI", () => {
  it("relativeTime", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(relativeTime("2026-11-26T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-25T12:00:00Z", "en", now)).toBe("yesterday");
  });

  it("/start with a saved draft shows the resume screen; Continue lands on the saved step", async () => {
    saveLocal({});
    mockApi({ get: { "/event-types": TYPES, "/pricing": { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd" } } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: null });
    expect(await screen.findByText(/pick up where you left off/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Family 2026" })).toBeInTheDocument();
    expect(screen.getByText(/3 people/)).toBeInTheDocument(); // Alex + 2
    expect(screen.getByText(/saved in this browser/i)).toBeInTheDocument();
    expect(screen.getByText(/5 minutes ago/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^continue/i }));
    expect(await screen.findByText("Ana")).toBeInTheDocument(); // people step
    expect(screen.queryByText(/pick up where you left off/i)).toBeNull();
  });

  it("Start a new exchange asks to confirm, then replaces the draft", async () => {
    saveLocal({});
    mockApi({ get: { "/event-types": TYPES } });
    const { store } = renderApp(<Wizard />, { route: "/start?type=secret_santa", path: "/start", signedIn: null });
    await userEvent.click(await screen.findByRole("button", { name: /start a new exchange/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => expect(screen.queryByText(/pick up where you left off/i)).toBeNull());
    expect(store.getState().wizard.draft.name).toBe("");
    expect(store.getState().wizard.step).toBe("service");
    expect(localStorage.getItem("qs_wizard_draft")).toBeNull();
  });

  it("a saved 'account' step resumes on the closest step once signed in", async () => {
    saveLocal({ includeMe: true }, "account");
    mockApi({ get: { "/event-types": TYPES, "/wizard/draft": { draft: null } }, put: { "/wizard/draft": { ok: true } } });
    const { store } = renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /^continue/i }));
    await waitFor(() => expect(store.getState().wizard.step).toBe("rules"));
  });

  it("dashboard shows the Continue card; Continue opens the wizard without the resume screen", async () => {
    saveLocal({});
    mockApi({ get: { "/event-types": TYPES, "/app/dashboard": { ok: true, tenant: { id: 7, max_events: 10 }, kpis: { events: 0, open: 0, drawn: 0, joined: 0, participants: 0 }, upcoming: [] }, "/app/my/events": { ok: true, items: [] } } });
    renderApp(
      <Routes>
        <Route path="/app" element={<Dashboard />} />
        <Route path="/start" element={<Wizard />} />
      </Routes>,
      { route: "/app", signedIn: user() },
    );
    expect(await screen.findByRole("article", { name: /unfinished exchange draft/i })).toBeInTheDocument();
    expect(screen.getByText(/saved to your account/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /% done/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^continue/i }));
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(screen.queryByText(/pick up where you left off/i)).toBeNull();
  });

  it("dashboard Delete draft (two-step) removes it", async () => {
    saveLocal({});
    const calls = mockApi({ get: { "/event-types": TYPES, "/wizard/draft": { draft: null } }, delete: { "/wizard/draft": { ok: true } } });
    renderApp(<Dashboard />, { route: "/app", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /delete draft/i }));
    await userEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => expect(screen.queryByRole("article", { name: /unfinished exchange draft/i })).toBeNull());
    await waitFor(() => expect(calls.some((c) => c.method === "delete" && c.url === "/wizard/draft")).toBe(true));
  });
});
