import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Wizard from "./Wizard";
import { emptyDraft } from "@/store/slices/wizardSlice";
import { mockApi, renderApp, user } from "@/test/render";

const TYPES = { ok: true, items: [{ id: 1, slug: "secret_santa", name_en: "Secret Santa", name_es: "Amigo secreto", description_en: "", description_es: "", icon: "gift", uses_draw: true, wishlist_mode: "off", is_active: true, sort_order: 1 }] };
const people = [1, 2, 3].map((i) => ({ name: `P${i}`, email: `p${i}@x.com` }));
const atPeople = (over: object = {}) => ({ wizard: { step: "people", draft: { ...emptyDraft(), name: "Party", ...over }, launching: false, error: null, result: null, savedAt: null, resumePending: false } }) as any;
// A preloaded draft has content → /start first asks "continue or start new?".
const resume = async () => userEvent.click(await screen.findByRole("button", { name: /^continue/i }));
const atAccount = (over: object = {}) => ({ wizard: { ...atPeople(over).wizard, step: "account" } }) as any;

describe("Wizard · People step asks for the organizer's name once", () => {
  it("one 'Your name' field (organizer card) and a separately labelled guest form", async () => {
    mockApi({ get: { "/event-types": TYPES } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: null, state: atPeople() });
    await resume();
    expect(await screen.findByRole("region", { name: /you, the organizer/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/your name/i)).toHaveLength(1);
    expect(screen.getByText(/add the people you're inviting/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Their name")).toBeInTheDocument();
    expect(screen.getByLabelText("Their email")).toBeInTheDocument();
    expect(screen.queryByText("?")).toBeNull(); // no "?" avatar before a name is typed
  });

  it("Add validates in field order and the error clears while typing", async () => {
    mockApi({ get: { "/event-types": TYPES } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: null, state: atPeople() });
    await resume();
    await userEvent.click(await screen.findByRole("button", { name: /^add$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/add the person's name/i);
    await userEvent.type(screen.getByLabelText("Their name"), "Ana");
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
  });

  it("your name is required even when you're not taking part (it's on the invitations)", async () => {
    mockApi({ get: { "/event-types": TYPES } });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: user({ full_name: "" }), state: atPeople({ includeMe: false, participants: people }) });
    await resume();
    await userEvent.click(await screen.findByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/tell us your name/i);
  });

  it("the account step never asks for the name again and sends it with the code", async () => {
    const calls = mockApi({
      get: { "/event-types": TYPES, "/auth/me": { user: user({ full_name: "Alex Gomez", memberships: [], active_tenant_id: null }) }, "/wizard/draft": { draft: null } },
      post: { "/auth/otp/request": { ok: true, is_new: true }, "/auth/otp/verify": { ok: true } },
      put: { "/wizard/draft": { ok: true } },
    });
    renderApp(<Wizard />, { route: "/start", path: "/start", signedIn: null, state: atAccount({ organizerName: "Alex Gomez", participants: people }) });
    await resume();
    await userEvent.type(await screen.findByLabelText(/^email$/i), "alex@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    await screen.findByText(/we sent a code|sent/i);
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    for (const input of screen.getAllByRole("textbox").filter((el) => el.getAttribute("inputmode") === "numeric")) await userEvent.type(input, "1");
    await userEvent.paste("123456");
    await waitFor(() => expect(calls.find((c) => c.url === "/auth/otp/verify")?.body).toMatchObject({ full_name: "Alex Gomez" }));
  });
});
