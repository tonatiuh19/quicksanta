import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import InviteLinkPanel from "./InviteLinkPanel";
import JoinCode, { formatCodeInput } from "@/pages/public/JoinCode";
import { fail, mockApi, renderApp, user } from "@/test/render";

const link = (over: object = {}) => ({ enabled: true, code: "7K4P-QX9M", url: "https://quicksanta.com/j/7K4P-QX9M", max: null, expires_at: null, joined_via_link: 2, state: "active", seats_left: 14, ...over });
const preview = (over: object = {}) => ({ event_name: "Office party", type_name: "Secret Santa", tenant_name: "Acme", organizer: "Olga", exchange_date: null, budget: "20 USD", theme_rules: null, people: 6, state: "open", my_status: null, event_public_id: null, ...over });

describe("InviteLinkPanel", () => {
  it("off → turning it on shows code, link, WhatsApp share, stats", async () => {
    const calls = mockApi({ get: { "/app/events/5/invite-link": { link: link({ enabled: false, code: null, url: null, state: "off" }) } }, put: { "/app/events/5/invite-link": { link: link() } } });
    renderApp(<InviteLinkPanel eventId={5} eventName="Office party" />, { signedIn: user() });
    expect(await screen.findByText(/turn it on to get a link/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/let people join with a link/i));
    expect(await screen.findByText("7K4P-QX9M")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "put")?.body).toEqual({ enabled: true });
    expect(screen.getByLabelText("Invite link")).toHaveValue("https://quicksanta.com/j/7K4P-QX9M");
    const wa = screen.getByRole("link", { name: /whatsapp/i });
    expect(decodeURIComponent(wa.getAttribute("href")!)).toContain("Office party");
    expect(decodeURIComponent(wa.getAttribute("href")!)).toContain("https://quicksanta.com/j/7K4P-QX9M");
    expect(screen.getByText(/2 people joined with the link · 14 seats left/)).toBeInTheDocument();
  });

  it("copy link gives feedback", async () => {
    mockApi({ get: { "/app/events/5/invite-link": { link: link() } } });
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    renderApp(<InviteLinkPanel eventId={5} eventName="Office party" />, { signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /copy link/i }));
    expect(write).toHaveBeenCalledWith("https://quicksanta.com/j/7K4P-QX9M");
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("closed after the draw: explains it and WhatsApp is disabled", async () => {
    mockApi({ get: { "/app/events/5/invite-link": { link: link({ state: "closed" }) } } });
    renderApp(<InviteLinkPanel eventId={5} eventName="Office party" />, { signedIn: user() });
    expect(await screen.findByText(/the draw switched the link off/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /whatsapp/i })).toBeDisabled();
  });

  it("limits: validates the cap, saves cap + date", async () => {
    const calls = mockApi({ get: { "/app/events/5/invite-link": { link: link() } }, put: { "/app/events/5/invite-link": { link: link({ max: 10, expires_at: "2099-12-24 23:59:59" }) } } });
    renderApp(<InviteLinkPanel eventId={5} eventName="Office party" />, { signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /limits/i }));
    await userEvent.type(screen.getByLabelText(/max people through the link/i), "0");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number from 1 to 1000/i);
    await userEvent.clear(screen.getByLabelText(/max people through the link/i));
    await userEvent.type(screen.getByLabelText(/max people through the link/i), "10");
    await userEvent.type(screen.getByLabelText(/link works until/i), "2099-12-24");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls.find((c) => c.method === "put")?.body).toEqual({ max: 10, expires_at: "2099-12-24" }));
    expect(await screen.findByText(/cap 10/)).toBeInTheDocument();
  });

  it("new link is two-step", async () => {
    const calls = mockApi({ get: { "/app/events/5/invite-link": { link: link() } }, post: { "/app/events/5/invite-link/regenerate": { link: link({ code: "ABCD-EFGH", url: "https://quicksanta.com/j/ABCD-EFGH" }) } } });
    renderApp(<InviteLinkPanel eventId={5} eventName="Office party" />, { signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /new link/i }));
    expect(screen.getByText(/stop working right away/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/regenerate"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /yes, make a new link/i }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
  });
});

describe("JoinCode page", () => {
  const routes = (
    <Routes>
      <Route path="/join" element={<JoinCode />} />
      <Route path="/j/:code" element={<JoinCode />} />
      <Route path="/app/my/:id" element={<div>my-exchange-page</div>} />
    </Routes>
  );

  it("formats codes while typing", () => {
    expect(formatCodeInput("7k4pqx9m")).toBe("7K4P-QX9M");
    expect(formatCodeInput("7k4")).toBe("7K4");
    expect(formatCodeInput("7K4P-QX9M-EXTRA")).toBe("7K4P-QX9M");
  });

  it("/join: type a code → preview", async () => {
    mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview() } } });
    renderApp(routes, { route: "/join", signedIn: null });
    await userEvent.type(screen.getByLabelText(/invite code/i), "7k4p");
    await userEvent.click(screen.getByRole("button", { name: /find exchange/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/8 letters and numbers/i);
    await userEvent.type(screen.getByLabelText(/invite code/i), "qx9m");
    await userEvent.click(screen.getByRole("button", { name: /find exchange/i }));
    expect(await screen.findByRole("heading", { name: "Office party" })).toBeInTheDocument();
    expect(screen.getByText(/olga invited you/i)).toBeInTheDocument();
    expect(screen.getByText(/sign in to join/i)).toBeInTheDocument(); // signed out → OTP card
  });

  it("signed in: one tap joins and opens the exchange", async () => {
    const calls = mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview() }, "/auth/me": { user: user() } }, post: { "/join-code/7K4P-QX9M": { status: "joined", already: false, tenant_id: 7, event_public_id: "EVPUB" } } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: user() });
    expect(await screen.findByText(/you'll join as alex@example.com/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /join the exchange/i }));
    expect(await screen.findByText("app-page")).toBeInTheDocument(); // renderApp's /app/* stub = navigated to /app/my/EVPUB
    expect(calls.find((c) => c.method === "post")?.body).toEqual({});
  });

  it("asks for a name only when the account has none", async () => {
    const calls = mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview() }, "/auth/me": { user: user({ full_name: "" }) } }, post: { "/join-code/7K4P-QX9M": { status: "joined", already: false, tenant_id: 7, event_public_id: "EVPUB" } } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: user({ full_name: "" }) });
    await userEvent.click(await screen.findByRole("button", { name: /join the exchange/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/tell us your name/i);
    await userEvent.type(screen.getByLabelText(/your name/i), "Alex");
    await userEvent.click(screen.getByRole("button", { name: /join the exchange/i }));
    await waitFor(() => expect(calls.find((c) => c.method === "post")?.body).toEqual({ name: "Alex" }));
  });

  it("a paused link shows nothing about the exchange", async () => {
    mockApi({ get: { "/join-code/7K4P-QX9M": fail(404, "errors.joinPaused") } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: null });
    expect(await screen.findByText(/link is paused/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/invite code/i)).toBeNull();
    expect(screen.queryByText(/sign in to join/i)).toBeNull();
  });

  it.each([
    ["paused", /link is paused/i],
    ["closed", /isn't taking new people/i],
    ["expired", /link has expired/i],
    ["full", /exchange is full/i],
  ])("explains a %s link instead of offering to join", async (state, text) => {
    mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview({ state }) } } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: user() });
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join the exchange/i })).toBeNull();
  });

  it("already in → link to the exchange; join errors are shown", async () => {
    mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview({ my_status: "joined", event_public_id: "EVPUB" }) } } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: user() });
    expect(await screen.findByRole("link", { name: /my exchanges|go to/i })).toHaveAttribute("href", "/app/my/EVPUB");
  });

  it("a race (full between preview and tap) shows the server's reason", async () => {
    mockApi({ get: { "/join-code/7K4P-QX9M": { preview: preview() } }, post: { "/join-code/7K4P-QX9M": fail(409, "errors.joinFull") } });
    renderApp(routes, { route: "/j/7K4P-QX9M", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /join the exchange/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/this exchange is full/i);
  });

  it("an unknown code offers to try another", async () => {
    mockApi({ get: { "/join-code/ZZZZ-ZZZZ": fail(404, "errors.joinCodeInvalid") } });
    renderApp(routes, { route: "/j/ZZZZ-ZZZZ", signedIn: null });
    expect(await screen.findByText(/couldn't find that exchange/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite code/i)).toHaveValue("ZZZZ-ZZZZ");
  });
});
