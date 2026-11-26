import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EventDetail from "./EventDetail";
import { fail, mockApi, renderApp, user } from "@/test/render";

const ev = (status = "open") => ({ id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", description: null, status, plan: "free", paid_at: null, budget_min: 20, budget_max: 30, currency: "USD", exchange_date: "2026-12-20", rsvp_deadline: null, location: null, allow_wishlists: true, participant_count: 4, joined_count: 2, drawn_at: null, created_at: "" });
const detail = (status = "open") => ({ ok: true, event: ev(status), uses_draw: true, max_participants: 20, tenant_plan: "free", pricing: { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd" }, exclusions: [], assignments: { total: 0, viewed: 0 } });
const people = { ok: true, items: [{ id: 1, public_id: "P1", event_id: 5, name: "Ana", email: "ana@x.com", status: "invited", has_wishlist: false, invited_at: null, joined_at: null, created_at: "" }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } };

describe("EventDetail (organizer)", () => {
  it("confirms and runs the draw, then shows the result", async () => {
    let drawn = false;
    const calls = mockApi({
      get: { "/app/events/5": () => detail(drawn ? "drawn" : "open"), "/app/events/5/participants": people },
      post: { "/app/events/5/draw": () => ((drawn = true), { ok: true, assigned: 4, notified: 4 }) },
    });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    expect((await screen.findAllByText("Ana")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /run the draw/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/secretly assign 4 people/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /draw now/i }));
    expect(await screen.findByText(/draw done! 4 people were notified/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/app/events/5/draw")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /reset draw/i })).toBeInTheDocument();
  });

  it("surfaces impossible-rule errors from the API", async () => {
    mockApi({
      get: { "/app/events/5": detail(), "/app/events/5/participants": people },
      post: { "/app/events/5/draw": fail(400, "validation.drawImpossible") },
    });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /run the draw/i }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /draw now/i }));
    expect(await screen.findByText(/these rules make a fair draw impossible/i)).toBeInTheDocument();
  });

  it("resends an invitation from the participants grid", async () => {
    const calls = mockApi({
      get: { "/app/events/5": detail(), "/app/events/5/participants": people },
      post: { "/app/events/5/participants/1/resend": { ok: true } },
    });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    await screen.findAllByText("Ana");
    await userEvent.click(screen.getAllByRole("button", { name: /resend invite/i })[0]);
    expect(await screen.findByText(/invitation sent again/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/app/events/5/participants/1/resend")).toBe(true);
  });
});

describe("EventDetail · Pro", () => {
  it("shows the upgrade banner on free exchanges and the pending-payment banner when unpaid", async () => {
    mockApi({ get: { "/app/events/5": detail(), "/app/events/5/participants": people } });
    const { unmount } = renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    expect(await screen.findByText("4/20 people on the free plan")).toBeInTheDocument();
    expect(screen.getByText(/up to 100 people · \$8\.90 once/i)).toBeInTheDocument();
    unmount();
    mockApi({ get: { "/app/events/5": detail("pending_payment"), "/app/events/5/participants": people } });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    expect(await screen.findByText("Payment pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $8.90" })).toBeInTheDocument();
  });
});
