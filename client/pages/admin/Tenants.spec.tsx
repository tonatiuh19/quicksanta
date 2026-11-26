import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Tenants from "./Tenants";
import { mockApi, renderApp, user } from "@/test/render";

const row = { id: 3, public_id: "T3", name: "Acme Corp", slug: "acme", status: "active", plan: "free", max_events: 10, max_participants_per_event: 100, owner_email: "boss@acme.com", member_count: 4, event_count: 2, created_at: "2026-11-01 00:00:00" };

describe("Command Center · Tenants", () => {
  it("opens the tenant drawer from the grid and suspends the tenant", async () => {
    const calls = mockApi({
      get: {
        "/admin/tenants": { ok: true, items: [row], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } },
        "/admin/tenants/3": { ok: true, tenant: row, members: [{ id: 1, user_id: 9, email: "boss@acme.com", full_name: "Boss", role: "organizer", status: "active", created_at: "" }], events: [] },
      },
      patch: { "/admin/tenants/3": { ok: true } },
    });
    renderApp(<Tenants />, { route: "/admin/tenants", path: "/admin/tenants", signedIn: user({ platform_role: "admin" }) });
    await userEvent.click((await screen.findAllByText("Acme Corp"))[0]);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("boss@acme.com")).toBeInTheDocument();
    await userEvent.selectOptions(within(drawer).getByLabelText("Status"), "suspended");
    expect(calls.find((c) => c.method === "patch")!.body).toEqual({ status: "suspended" });
  });
});
