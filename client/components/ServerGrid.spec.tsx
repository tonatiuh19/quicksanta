import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ServerGrid from "./ServerGrid";
import { mockApi, renderApp } from "@/test/render";

type Row = { id: number; name: string; status: string };
const page = (items: Row[], p = 1, total = 60) => ({ ok: true, items, pagination: { page: p, limit: 25, total, totalPages: Math.ceil(total / 25) } });

describe("ServerGrid (server-side sort / search / filter / paging)", () => {
  it("sends every interaction to the API instead of sorting locally", async () => {
    const calls = mockApi({ get: { "/admin/tenants": (_u: string, _b: any, cfg: any) => page([{ id: cfg.params.page, name: `Acme p${cfg.params.page}`, status: "active" }], cfg.params.page) } });
    renderApp(
      <ServerGrid<Row>
        grid="adminTenants"
        rowKey={(r) => r.id}
        columns={[
          { key: "name", label: "Name", sortable: true },
          { key: "status", label: "Status" },
        ]}
        filters={[{ key: "status", label: "Status", options: [{ value: "suspended", label: "Suspended" }] }]}
      />,
    );
    expect(await screen.findByText("Acme p1")).toBeInTheDocument();
    expect(calls.at(-1)!.params).toEqual({ page: 1, limit: 25, sort_by: "created_at", sort_dir: "DESC" });

    await userEvent.click(screen.getByRole("button", { name: /name/i }));
    await waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ sort_by: "name", sort_dir: "ASC" }));
    await userEvent.click(screen.getByRole("button", { name: /name/i }));
    await waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ sort_by: "name", sort_dir: "DESC" }));

    await userEvent.selectOptions(screen.getByLabelText("Status"), "suspended");
    await waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ status: "suspended", page: 1 }));

    await userEvent.type(screen.getByRole("searchbox"), "acme");
    await waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ q: "acme" }), { timeout: 1500 });

    await userEvent.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(calls.at(-1)!.params).toMatchObject({ page: 2 }));
    expect(await screen.findByText("Acme p2")).toBeInTheDocument();
    expect(screen.getByText("Showing 26–50 of 60")).toBeInTheDocument();
  });

  it("shows API errors with a retry", async () => {
    mockApi({ get: { "/admin/users": { __status: 403, data: { error: "errors.forbidden" } } as any } });
    renderApp(<ServerGrid<Row> grid="adminUsers" rowKey={(r) => r.id} columns={[{ key: "name", label: "Name" }]} />);
    expect(await screen.findByText("You don't have access to this.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
