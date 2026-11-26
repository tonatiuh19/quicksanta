import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Wizard from "./Wizard";
import { mockApi, renderApp, user } from "@/test/render";

const TYPES = {
  ok: true,
  items: [
    { id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "Draw", description_es: "", icon: "gift", uses_draw: true, is_active: true, sort_order: 1 },
    { id: 2, slug: "white_elephant", name_en: "White Elephant", name_es: "Elefante", description_en: "Steal", description_es: "", icon: "party", uses_draw: false, is_active: true, sort_order: 2 },
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
