import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmailGallery, { forceDark } from "./EmailGallery";
import EventDetail from "@/pages/app/EventDetail";
import { fail, mockApi, renderApp, user } from "@/test/render";

const html = (lang: string) => `<!doctype html><html lang="${lang}"><head><style>@media (prefers-color-scheme: dark){.qs-bg{background:#141110!important}}</style></head><body>${lang === "es" ? "Hola" : "Hello"}</body></html>`;

describe("Command Center → Email gallery", () => {
  it("lists templates, previews in a sandboxed iframe, switches language / width / text, sends a test to me", async () => {
    const calls = mockApi({
      get: {
        "/admin/email-previews": { ok: true, items: [{ key: "invite", subject: "Olga invited you" }, { key: "payment_failed", subject: "Action needed" }] },
        "/admin/email-previews/*": (url: string, _b: unknown, cfg: any) => ({ ok: true, subject: `${url.split("/").pop()} ${cfg?.params?.lang}`, html: html(cfg?.params?.lang), text: `TEXT ${cfg?.params?.lang}` }),
      },
      post: { "/admin/email-previews/payment_failed/send": { ok: true, dry_run: false, to: "alex@example.com" } },
    });
    renderApp(<EmailGallery />, { route: "/admin/email-gallery", signedIn: user({ platform_role: "owner" }) });
    const frame = await screen.findByTitle(/preview of invitation/i);
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("Hello");

    await userEvent.click(screen.getByRole("radio", { name: "ES" }));
    await waitFor(() => expect(screen.getByTitle(/preview of invitation/i).getAttribute("srcdoc")).toContain("Hola"));
    expect(screen.getByText("invite es")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /phone/i }));
    expect(document.querySelector(".qs-gallery-frame.is-phone")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect(screen.getByTitle(/preview of invitation/i).getAttribute("srcdoc")).toContain("@media all{");
    await userEvent.click(screen.getByRole("radio", { name: /plain text/i }));
    expect(screen.getByText("TEXT es")).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("navigation", { name: /templates/i })).getByRole("button", { name: /payment failed/i }));
    await userEvent.click(screen.getByRole("button", { name: /send a test to me/i }));
    expect(await screen.findByText(/test sent to alex@example.com/i)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "post")?.body).toEqual({ lang: "es" });
  });

  it("forceDark turns the template's dark rules on", () => {
    expect(forceDark(html("en"))).toContain("@media all{.qs-bg");
  });
});

describe("Exchange → Remind people who haven't joined", () => {
  const ev = { id: 5, public_id: "EV", tenant_id: 7, event_type_slug: "secret_santa", event_type_name: "Secret Santa", name: "Office", description: null, status: "open", plan: "free", paid_at: null, budget_min: null, budget_max: null, currency: "USD", exchange_date: null, rsvp_deadline: null, location: null, allow_wishlists: false, wishlist_mode: "off", participant_count: 6, joined_count: 2, drawn_at: null, created_at: "2026-11-01", custom: null, uses_draw: true, theme_rules: null, reveal_mode: "private" };
  const detail = { ok: true, event: ev, uses_draw: true, max_participants: 20, tenant_plan: "free", pricing: { free_max_participants: 20, pro_max_participants: 100, pro_price_cents: 890, pro_currency: "usd", pro_interval: "month", grace_days: 3, save_offer_percent: 50 }, exclusions: [], assignments: { total: 0, viewed: 0 } };
  const base = { "/app/events/5": detail, "/app/events/5/participants": { ok: true, items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } }, "/app/events/5/invite-link": { link: { enabled: false, code: null, url: null, max: null, expires_at: null, joined_via_link: 0, state: "off", seats_left: 14 } } };

  it("shows how many haven't joined, confirms, sends, toasts the count", async () => {
    const calls = mockApi({ get: base, post: { "/app/events/5/remind": { ok: true, reminded: 4, pending: 4 } } });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    expect(await screen.findByText("4 people haven't joined yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remind 4 people/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/once a day/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /send reminder/i }));
    expect(await screen.findByText("Reminder sent to 4 people.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/app/events/5/remind")).toHaveLength(1);
  });

  it("explains the daily limit", async () => {
    mockApi({ get: base, post: { "/app/events/5/remind": fail(429, "errors.remindedToday") } });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    await userEvent.click(await screen.findByRole("button", { name: /remind 4 people/i }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /send reminder/i }));
    expect(await screen.findByText(/already sent a reminder today/i)).toBeInTheDocument();
  });

  it("hidden when everyone joined or after the draw", async () => {
    mockApi({ get: { ...base, "/app/events/5": { ...detail, event: { ...ev, joined_count: 6 } } } });
    renderApp(<EventDetail />, { route: "/app/events/5", path: "/app/events/:id", signedIn: user() });
    await screen.findByText("Office");
    expect(screen.queryByRole("button", { name: /remind/i })).toBeNull();
  });
});
