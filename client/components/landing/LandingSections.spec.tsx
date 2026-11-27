import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import Landing from "@/pages/public/Landing";
import Leads from "@/pages/admin/Leads";
import { fail, mockApi, renderApp, user } from "@/test/render";

const home = (
  <Routes>
    <Route path="/" element={<Landing />} />
    <Route path="/j/:code" element={<div>join-page</div>} />
    <Route path="/join" element={<div>join-enter-page</div>} />
  </Routes>
);

describe("Home: sections for the newer features", () => {
  it("'Have a code?' strip formats the code and opens the join page", async () => {
    mockApi({});
    renderApp(home, { route: "/" });
    const strip = screen.getByRole("region", { name: /got an invite code/i });
    const input = within(strip).getByLabelText(/invite code/i);
    await userEvent.type(input, "7k4p");
    await userEvent.click(within(strip).getByRole("button", { name: /^join/i }));
    expect(within(strip).getByRole("alert")).toHaveTextContent(/8 letters and numbers/i);
    await userEvent.type(input, "qx9m");
    expect(input).toHaveValue("7K4P-QX9M");
    await userEvent.click(within(strip).getByRole("button", { name: /^join/i }));
    expect(await screen.findByText("join-page")).toBeInTheDocument();
  });

  it("nav has 'Have a code?'", async () => {
    mockApi({});
    renderApp(home, { route: "/" });
    await userEvent.click(screen.getByRole("link", { name: /have a code\?/i }));
    expect(await screen.findByText("join-enter-page")).toBeInTheDocument();
  });

  it("invite-link showcase (free) and how-it-works mention links; wishlist copy is accurate", () => {
    mockApi({});
    renderApp(home, { route: "/" });
    expect(screen.getByRole("heading", { name: /share one link\. everyone's in\./i })).toBeInTheDocument();
    expect(screen.getByText(/new · free on every plan/i)).toBeInTheDocument();
    expect(screen.getByText(/or share one link, code or qr/i)).toBeInTheDocument();
    expect(screen.getByText(/plus their wishlist when the exchange uses one/i)).toBeInTheDocument();
    expect(screen.getAllByText("Invite link, code & QR").length).toBeGreaterThan(0); // Free plan list
  });

  it("Create your own designer: icon, color and draw toggle restyle the sample ticket", async () => {
    mockApi({});
    renderApp(home, { route: "/" });
    const section = document.getElementById("create-your-own")!;
    const coffee = within(section).getByRole("radio", { name: "Coffee" });
    await userEvent.click(coffee);
    expect(coffee).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(section).getByRole("radio", { name: /blue/i }));
    expect(within(section).getByRole("radio", { name: /blue/i })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(section).getByLabelText("Secret draw"));
    expect(within(section).getByText("Open swap")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /design your exchange/i })).toHaveAttribute("href", "/start?type=custom");
  });

  it("FAQ has the new questions", async () => {
    mockApi({});
    renderApp(home, { route: "/" });
    for (const q of [/join with a link/i, /join after we've started/i, /wishlists work for every service/i]) expect(screen.getByRole("button", { name: q })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /wishlists work for every service/i }));
    expect(screen.getByText(/secret santa, white elephant and cookie swap keep it a surprise/i)).toBeVisible();
  });

  it("Enterprise → Contact sales: validates, posts, thanks", async () => {
    const calls = mockApi({ post: { "/contact": { ok: true } } });
    renderApp(home, { route: "/" });
    await userEvent.click(screen.getByRole("button", { name: /contact sales/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^send/i }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/tell us your name/i);
    await userEvent.type(within(dialog).getByLabelText(/your name/i), "Ana Pérez");
    await userEvent.type(within(dialog).getByLabelText(/work email/i), "Ana@Acme.com");
    await userEvent.click(within(dialog).getByRole("button", { name: /^send/i }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/how many people/i);
    await userEvent.selectOptions(within(dialog).getByLabelText(/how many people/i), "100_500");
    await userEvent.type(within(dialog).getByLabelText(/company/i), "Acme");
    await userEvent.click(within(dialog).getByRole("button", { name: /^send/i }));
    expect(await within(dialog).findByText(/thanks! we got it/i)).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/contact")?.body).toMatchObject({ name: "Ana Pérez", email: "ana@acme.com", company: "Acme", team_size: "100_500", website: "" });
  });

  it("contact form shows server errors (e.g. rate limit)", async () => {
    mockApi({ post: { "/contact": fail(429, "errors.tooMany") } });
    renderApp(home, { route: "/" });
    await userEvent.click(screen.getByRole("button", { name: /contact sales/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/your name/i), "Ana");
    await userEvent.type(within(dialog).getByLabelText(/work email/i), "ana@acme.com");
    await userEvent.selectOptions(within(dialog).getByLabelText(/how many people/i), "lt50");
    await userEvent.click(within(dialog).getByRole("button", { name: /^send/i }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(within(dialog).queryByText(/thanks!/i)).toBeNull();
  });
});

describe("Command Center → Leads", () => {
  const row = { id: 3, name: "Ana", email: "ana@acme.com", company: "Acme", team_size: "100_500", message: "3 offices", locale: "en", status: "new", notes: null, handled_by_name: null, created_at: "2026-11-27 10:00:00" };
  it("lists leads; status change and notes are saved", async () => {
    const calls = mockApi({ get: { "/admin/leads": { ok: true, items: [row], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } } }, patch: { "/admin/leads/3": { ok: true } } });
    renderApp(<Leads />, { route: "/admin/leads", signedIn: user({ platform_role: "owner" }) });
    const status = (await screen.findAllByLabelText(/status for ana/i))[0];
    await userEvent.selectOptions(status, "contacted");
    await waitFor(() => expect(calls.find((c) => c.method === "patch")?.body).toEqual({ status: "contacted" }));
    // The grid reloads after a save; click the fresh row.
    await waitFor(() => expect(calls.filter((c) => c.method === "get" && c.url === "/admin/leads").length).toBeGreaterThanOrEqual(2));
    await userEvent.click((await screen.findAllByRole("button", { name: /notes for ana/i }))[0]);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "Call Tuesday");
    await userEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "patch").at(-1)?.body).toEqual({ notes: "Call Tuesday" }));
  });
});
