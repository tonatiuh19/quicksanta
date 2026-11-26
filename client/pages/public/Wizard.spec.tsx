import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Wizard from "./Wizard";
import { mockApi, renderApp, user } from "@/test/render";

const TYPES = {
  ok: true,
  items: [
    { id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "Draw", description_es: "", icon: "gift", uses_draw: true, wishlist_mode: "off", is_active: true, sort_order: 1 },
    { id: 5, slug: "wishlist_exchange", name_en: "Wishlist Exchange", name_es: "Listas", description_en: "Lists", description_es: "", icon: "list", uses_draw: true, requires_pro: true, wishlist_mode: "required", is_active: true, sort_order: 5 },
    { id: 2, slug: "white_elephant", name_en: "White Elephant", name_es: "Elefante", description_en: "Steal", description_es: "", icon: "party", uses_draw: false, is_active: true, sort_order: 2 },
    { id: 3, slug: "book_swap", name_en: "Book Swap", name_es: "Libros", description_en: "Books", description_es: "", icon: "book", uses_draw: true, requires_pro: true, is_active: true, sort_order: 3 },
    { id: 4, slug: "custom", name_en: "Create your own", name_es: "Crea el tuyo", description_en: "Design it", description_es: "", icon: "sparkles", uses_draw: true, requires_pro: true, is_active: true, sort_order: 999 },
  ],
};

describe("Wizard", () => {
  it("walks service → details → people → rules → review and launches with the right payload", async () => {
    const me = user({ memberships: [], active_tenant_id: null });
    const calls = mockApi({
      get: { "/event-types": TYPES, "/auth/me": { user: me } },
      post: { "/wizard/launch": { ok: true, tenant_id: 7, event_id: 55, event_public_id: "E", invited: 3 } },
    });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });

    // Service
    await userEvent.click(await screen.findByRole("radio", { name: /secret santa/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Details: name required
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/give your exchange a name/i);
    await userEvent.type(screen.getByLabelText(/exchange name/i), "Office Party");
    await userEvent.click(screen.getByRole("button", { name: /~25 USD/ }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // People: paste a list (one invalid line stays)
    await userEvent.click(screen.getByRole("button", { name: /paste a list/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /paste a list/i }), "Ana <ana@x.com>{enter}bob@x.com{enter}Carla, carla@x.com{enter}junk");
    await userEvent.click(screen.getByRole("button", { name: /add all/i }));
    const list = screen.getByRole("list", { name: /people/i });
    expect(within(list).getByText("Ana")).toBeInTheDocument();
    expect(within(list).getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText(/1 line\(s\) without a valid email/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Rules: Ana ⇄ Bob (stored by email)
    await userEvent.selectOptions(screen.getByLabelText("Person"), "ana@x.com");
    await userEvent.selectOptions(screen.getByLabelText("Can't get"), "bob@x.com");
    await userEvent.click(screen.getByRole("button", { name: /add rule/i }));
    expect(screen.getByText(/never paired/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Review (account step skipped: already signed in)
    expect(screen.getByText(/ready to launch/i)).toBeInTheDocument();
    expect(screen.getAllByText("4 people").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /launch exchange/i }));
    await waitFor(() => expect(screen.getByText(/your exchange is live/i)).toBeInTheDocument());

    const body = calls.find((c) => c.url === "/wizard/launch")!.body;
    expect(body).toMatchObject({
      eventTypeSlug: "secret_santa",
      name: "Office Party",
      budgetMin: 19,
      budgetMax: 25,
      includeMe: true,
      organizerName: "Alex Gomez",
      exclusions: [{ a: "ana@x.com", b: "bob@x.com", bidirectional: true }],
    });
    expect(body.participants.map((p: any) => p.email)).toEqual(["ana@x.com", "bob@x.com", "carla@x.com"]);
  });

  it("requires 3 people for draw-based services", async () => {
    const me = user();
    mockApi({ get: { "/event-types": TYPES, "/auth/me": { user: me } } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });
    await userEvent.click(await screen.findByRole("radio", { name: /secret santa/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.type(screen.getByLabelText(/exchange name/i), "Tiny");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Ana");
    await userEvent.type(screen.getByLabelText("Email"), "ana@x.com");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least 3 people in total.");
  });

  it("shows the account (OTP) step when signed out, and hides rules for no-draw services", async () => {
    mockApi({ get: { "/event-types": TYPES, "/auth/me": { __status: 401, data: { error: "errors.unauthorized" } } as any } });
    renderApp(<Wizard />, { route: "/start?type=white_elephant", path: "/start", signedIn: null });
    const steps = await screen.findByRole("list", { name: /progress/i });
    await waitFor(() => expect(within(steps).queryByText("Rules")).not.toBeInTheDocument());
    expect(within(steps).getByText("Account")).toBeInTheDocument();
  });
});

describe("Wizard · Pro services and Create your own", () => {
  it("shows Pro badges (locked on Free) and forces Pro at review for Pro-only services", async () => {
    const me = user({ memberships: [], active_tenant_id: null });
    mockApi({ get: { "/event-types": TYPES, "/auth/me": { user: me }, "/pricing": { ok: true, free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd", pro_interval: "month", grace_days: 3, save_offer_percent: 50 } } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });
    const book = await screen.findByRole("radio", { name: /book swap/i });
    expect(within(book).getByText("Pro")).toBeInTheDocument();
    expect(within(screen.getByRole("radio", { name: /^secret santa/i })).queryByText("Pro")).not.toBeInTheDocument();
    await userEvent.click(book);
    expect(screen.getByText(/This is a Pro service/)).toBeInTheDocument();
  });

  it("Create your own: design step (name, icon, color, no-draw, rules, template) → no rules step → launch payload", async () => {
    const me = user({ memberships: [{ tenant_id: 7, tenant_public_id: "T7", tenant_name: "Gomez", tenant_slug: "g", tenant_status: "active", role: "organizer", tenant_plan: "pro" }] });
    const calls = mockApi({
      get: { "/event-types": TYPES, "/auth/me": { user: me }, "/app/templates": { ok: true, items: [] }, "/pricing": { ok: true, free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd", pro_interval: "month", grace_days: 3, save_offer_percent: 50 } },
      post: { "/wizard/launch": { ok: true, tenant_id: 7, event_id: 60, event_public_id: "E", invited: 1, payment_required: false } },
    });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });
    await userEvent.click(await screen.findByRole("radio", { name: /create your own/i }));
    expect(within(screen.getByRole("radio", { name: /create your own/i })).getByText("Pro")).toBeInTheDocument(); // badge, not locked
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("heading", { name: /design your exchange/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
    await userEvent.type(screen.getByLabelText(/exchange style name/i), "Ugly Sweater Swap");
    await userEvent.click(screen.getByRole("radio", { name: "snowflake" }));
    await userEvent.click(screen.getByRole("radio", { name: "Green" }));
    await userEvent.click(screen.getByRole("radio", { name: /no draw/i }));
    await userEvent.type(screen.getByLabelText(/theme or house rules/i), "Must be knitted");
    await userEvent.click(screen.getByText(/save this design as a template/i));
    expect(screen.getAllByText("Ugly Sweater Swap").length).toBeGreaterThan(0); // live ticket preview
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.type(screen.getByLabelText(/exchange name/i), "Office Sweaters");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Ana");
    await userEvent.type(screen.getByLabelText("Email"), "ana@x.com");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    // No-draw design skips Rules → straight to review
    expect(screen.getByText(/ready to launch/i)).toBeInTheDocument();
    expect(screen.getByText(/Covered by your Pro plan/)).toBeInTheDocument();
    expect(screen.getAllByText("2 people").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /launch exchange/i }));
    const body = calls.find((c) => c.url === "/wizard/launch")!.body;
    expect(body).toMatchObject({
      eventTypeSlug: "custom",
      plan: "pro",
      saveTemplate: true,
      custom: { name: "Ugly Sweater Swap", icon: "snowflake", color: "green", matchMode: "none", themeRules: "Must be knitted", revealMode: "private" },
    });
  });

  it("singular: 1 person", async () => {
    const me = user({ memberships: [], active_tenant_id: null });
    mockApi({ get: { "/event-types": TYPES, "/auth/me": { user: me } } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });
    expect(await screen.findByText("1 person")).toBeInTheDocument();
  });
});

describe("Wizard · wishlists by service", () => {
  it("Secret Santa shows no wishlist toggle; Wishlist Exchange says they're included", async () => {
    const me = user({ memberships: [], active_tenant_id: null });
    mockApi({ get: { "/event-types": TYPES, "/auth/me": { user: me } } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: me });
    await userEvent.click(await screen.findByRole("radio", { name: /^secret santa/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.queryByText(/let people share wishlists/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /back/i }));
    await userEvent.click(screen.getByRole("radio", { name: /wishlist exchange/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText(/Everyone shares a wishlist/)).toBeInTheDocument();
    expect(screen.queryByText(/let people share wishlists/i)).not.toBeInTheDocument();
  });
});
