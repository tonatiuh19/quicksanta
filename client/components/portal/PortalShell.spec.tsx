import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import AdminLayout, { ADMIN_NAV } from "@/pages/admin/AdminLayout";
import AppLayout, { APP_NAV } from "@/pages/app/AppLayout";
import { filterNav } from "./PortalShell";
import { mockApi, renderApp, user } from "@/test/render";

describe("nav filtering", () => {
  it("participants never see the Organize section", () => {
    const items = filterNav(APP_NAV, null, "participant").map((i) => i.to);
    expect(items).toEqual(["/app", "/app/my", "/app/profile"]);
  });
  it("organizers see everything in their workspace", () => {
    expect(filterNav(APP_NAV, null, "organizer")).toHaveLength(APP_NAV.length);
  });
  it("non-platform users see nothing permissioned in the Command Center", () => {
    expect(filterNav(ADMIN_NAV, null, null).map((i) => i.to)).toEqual(["/admin/profile"]);
    expect(filterNav(ADMIN_NAV, "admin", null).length).toBe(ADMIN_NAV.length);
  });
});

describe("PortalShell", () => {
  it("renders category headings and the mobile tab bar with a More sheet", async () => {
    mockApi({});
    renderApp(
      <Routes>
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<p>dash</p>} />
        </Route>
      </Routes>,
      { route: "/app", signedIn: user() },
    );
    const sidebar = screen.getByRole("complementary", { name: "Menu" });
    expect(within(sidebar).getByText("Organize")).toBeInTheDocument();
    expect(within(sidebar).getByText("Setup")).toBeInTheDocument();
    const tabbar = screen.getByRole("navigation", { name: /quick navigation/i });
    expect(within(tabbar).getAllByRole("link")).toHaveLength(4);
    const more = within(tabbar).getByRole("button", { name: /more/i });
    await userEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  it("redirects regular users away from the Command Center", async () => {
    mockApi({});
    renderApp(
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<p>overview</p>} />
        </Route>
      </Routes>,
      { route: "/admin", signedIn: user({ platform_role: null }) },
    );
    expect(await screen.findByText("app-page")).toBeInTheDocument();
  });

  it("platform owners get the Command Center sections", () => {
    mockApi({});
    renderApp(
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<p>overview</p>} />
        </Route>
      </Routes>,
      { route: "/admin", signedIn: user({ platform_role: "owner" }) },
    );
    const sidebar = screen.getByRole("complementary", { name: "Menu" });
    for (const s of ["Tenants & people", "Activity", "Platform"]) expect(within(sidebar).getByText(s)).toBeInTheDocument();
  });

  it("sends signed-out users to /login", async () => {
    mockApi({ get: { "/auth/me": { __status: 401, data: { error: "errors.unauthorized" } } as any } });
    renderApp(
      <Routes>
        <Route path="/app" element={<AppLayout />} />
      </Routes>,
      { route: "/app" },
    );
    expect(await screen.findByText("login-page")).toBeInTheDocument();
  });
});
