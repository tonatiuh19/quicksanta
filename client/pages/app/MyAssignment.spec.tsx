import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyAssignment from "./MyAssignment";
import { mockApi, renderApp, user } from "@/test/render";

const event = { id: 5, public_id: "EVT", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", description: null, status: "drawn", budget_min: 20, budget_max: 30, currency: "USD", exchange_date: "2026-12-20", rsvp_deadline: null, location: "HQ", allow_wishlists: true, participant_count: 4, joined_count: 4, drawn_at: null, created_at: "", plan: "free", paid_at: null, custom: null, uses_draw: true, theme_rules: null, reveal_mode: "private" };

describe("MyAssignment", () => {
  it("reveals the receiver and their wishlist on tap, and saves my wishlist", async () => {
    const calls = mockApi({
      get: { "/app/my/events/EVT": { ok: true, event, me: { participant_id: 1, name: "Me", wishlist: "socks", status: "joined" }, receiver: { name: "Ana", wishlist: "Books please" } } },
      put: { "/app/my/events/EVT/wishlist": { ok: true } },
    });
    renderApp(<MyAssignment />, { route: "/app/my/EVT", path: "/app/my/:publicId", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /reveal my match/i }));
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("Books please")).toBeInTheDocument();

    const box = screen.getByRole("textbox", { name: /my wishlist/i });
    expect(box).toHaveValue("socks");
    await userEvent.clear(box);
    await userEvent.type(box, "A scarf");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "put")!.body).toEqual({ wishlist: "A scarf" });
  });

  it("shows the waiting state before the draw", async () => {
    mockApi({ get: { "/app/my/events/EVT": { ok: true, event: { ...event, status: "open" }, me: { participant_id: 1, name: "Me", wishlist: null, status: "joined" }, receiver: null } } });
    renderApp(<MyAssignment />, { route: "/app/my/EVT", path: "/app/my/:publicId", signedIn: user() });
    expect(await screen.findByText(/draw hasn't happened yet/i)).toBeInTheDocument();
  });
});
