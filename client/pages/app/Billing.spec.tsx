import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Billing from "./Billing";
import { fail, mockApi, renderApp, user } from "@/test/render";

const pricing = { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd", pro_interval: "month", grace_days: 3, save_offer_percent: 50 };
const overview = (over: Record<string, unknown> = {}) => ({
  ok: true,
  plan: "pro",
  status: "active",
  current_period_end: "2026-12-26 00:00:00",
  cancel_at_period_end: false,
  save_offer_available: true,
  card: { brand: "visa", last4: "4242", exp: "12/2034" },
  pricing,
  usage: { events: 2, largest: 35, pending: 0, limit: 100 },
  invoices: [{ id: "in_1", number: "QS-0001", status: "paid", amount_cents: 890, currency: "usd", created: 1795000000, hosted_invoice_url: "https://inv", invoice_pdf: "https://pdf" }],
  ...over,
});
const me = user({ memberships: [{ tenant_id: 7, tenant_public_id: "T7", tenant_name: "Gomez Family", tenant_slug: "g", tenant_status: "active", role: "organizer" }] });

describe("Billing portal", () => {
  it("shows the Pro plan, renewal, usage meter, card and invoices", async () => {
    mockApi({ get: { "/app/billing": overview() } });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    expect(await screen.findByRole("heading", { name: /pro/i })).toBeInTheDocument();
    expect(screen.getByText(/Renews on Dec 2[56], 2026 for \$8\.90/)).toBeInTheDocument();
    expect(screen.getByText("35/100")).toBeInTheDocument();
    expect(screen.getByText("•••• 4242")).toBeInTheDocument();
    expect(screen.getByText("QS-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download pdf/i })).toHaveAttribute("href", "https://pdf");
  });

  it("free plan shows the upgrade CTA and no cancel option", async () => {
    mockApi({ get: { "/app/billing": overview({ plan: "free", status: "none", card: null, invoices: [], usage: { events: 1, largest: 19, pending: 1, limit: 20 } }) } });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    expect(await screen.findByRole("button", { name: /upgrade to pro · \$8\.90\/mo/i })).toBeInTheDocument();
    expect(screen.getByText(/1 exchange\(s\) are waiting for Pro/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage plan/i })).not.toBeInTheDocument();
  });

  it("past_due shows the fix-payment banner; scheduled cancel shows resume", async () => {
    const calls = mockApi({ get: { "/app/billing": overview({ status: "past_due" }) } });
    const { unmount } = renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    expect(await screen.findByText(/last payment didn't go through/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update card & retry/i })).toBeInTheDocument();
    unmount();
    mockApi({ get: { "/auth/me": { user: me }, "/app/billing": overview({ cancel_at_period_end: true }) }, post: { "/app/billing/resume": { ok: true } } });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    await userEvent.click(await screen.findByRole("button", { name: /resume pro/i }));
    expect(await screen.findByText(/Pro resumed/)).toBeInTheDocument();
    void calls;
  });

  it("cancel flow: hidden under Manage plan → reason → save offer → confirm with the workspace name", async () => {
    const calls = mockApi({
      get: { "/auth/me": { user: me }, "/app/billing": overview() },
      post: { "/app/billing/cancel": { ok: true, current_period_end: "2026-12-26 00:00:00" } },
    });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    expect(screen.queryByRole("button", { name: /cancel subscription/i })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /manage plan/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel subscription/i }));
    const dialog = screen.getByRole("dialog");
    const next = within(dialog).getByRole("button", { name: /continue/i });
    expect(next).toBeEnabled(); // a reason is optional (cancelling must stay easy)
    await userEvent.click(within(dialog).getByRole("radio", { name: /too expensive/i }));
    await userEvent.click(next);
    expect(within(dialog).getByText(/Stay and get 50% off next month/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /no thanks/i }));
    const confirm = within(dialog).getByRole("button", { name: /^cancel subscription$/i });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/workspace name/i), "gomez family");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await screen.findByText(/Subscription cancelled/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/app/billing/cancel")!.body).toEqual({ reason: "too_expensive", feedback: "", confirm_name: "gomez family" });
  });

  it("accepting the save offer keeps the subscription", async () => {
    const calls = mockApi({ get: { "/auth/me": { user: me }, "/app/billing": overview() }, post: { "/app/billing/save-offer": { ok: true, percent: 50 } } });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    await userEvent.click(await screen.findByRole("button", { name: /manage plan/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel subscription/i }));
    await userEvent.click(screen.getByRole("radio", { name: /only needed it once/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.click(screen.getByRole("button", { name: /stay with 50% off/i }));
    expect(await screen.findByText(/Offer applied/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/app/billing/cancel")).toBe(false);
  });

  it("without the offer available, goes straight to confirmation; API errors are shown", async () => {
    mockApi({ get: { "/app/billing": overview({ save_offer_available: false }) }, post: { "/app/billing/cancel": fail(400, "errors.confirmNameMismatch") } });
    renderApp(<Billing />, { route: "/app/billing", path: "/app/billing", signedIn: me });
    await userEvent.click(await screen.findByRole("button", { name: /manage plan/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel subscription/i }));
    await userEvent.click(screen.getByRole("radio", { name: /^other$/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Before you go")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Gomez Family");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^cancel subscription$/i }));
    expect(await screen.findByText("The name doesn't match your workspace.")).toBeInTheDocument();
  });
});
