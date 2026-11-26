/**
 * UI test helper: real Redux store + router + i18n (EN). The network is mocked by
 * stubbing the shared axios instance (`mockApi`), so thunks run exactly as in production.
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { makeStore, type RootState } from "@/store";
import type { SessionUser } from "@shared/api";

void i18n.changeLanguage("en");

type Handler = (url: string, body?: any, config?: any) => any;
export function mockApi(routes: Partial<Record<"get" | "post" | "patch" | "put" | "delete", Record<string, Handler | object>>>) {
  const calls: Array<{ method: string; url: string; body?: any; params?: any }> = [];
  for (const method of ["get", "post", "patch", "put", "delete"] as const) {
    vi.spyOn(api, method as any).mockImplementation((async (url: string, a?: any, b?: any) => {
      const body = method === "get" || method === "delete" ? undefined : a;
      const config = method === "get" || method === "delete" ? a : b;
      calls.push({ method, url, body, params: config?.params });
      const table = routes[method] ?? {};
      const key = Object.keys(table).find((k) => (k.endsWith("*") ? url.startsWith(k.slice(0, -1)) : k === url));
      if (!key) {
        const err: any = new Error(`unmocked ${method.toUpperCase()} ${url}`);
        err.isAxiosError = true;
        err.response = { status: 404, data: { error: "errors.notFound" } };
        throw err;
      }
      const h = table[key];
      const out = typeof h === "function" ? await (h as Handler)(url, body, config) : h;
      if (out && (out as any).__status) {
        const err: any = new Error("api error");
        err.isAxiosError = true;
        err.response = { status: (out as any).__status, data: (out as any).data };
        throw err;
      }
      return { data: out };
    }) as any);
  }
  return calls;
}

export const fail = (status: number, error: string, extra: object = {}) => ({ __status: status, data: { error, ...extra } });

export function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1,
    public_id: "U1",
    email: "alex@example.com",
    full_name: "Alex Gomez",
    locale: "en",
    platform_role: null,
    memberships: [{ tenant_id: 7, tenant_public_id: "T7", tenant_name: "Gomez Family", tenant_slug: "gomez", tenant_status: "active", role: "organizer", tenant_plan: "free" }],
    active_tenant_id: 7,
    ...over,
  };
}

export function renderApp(ui: ReactElement, opts: { route?: string; path?: string; state?: Partial<RootState>; signedIn?: SessionUser | null } = {}) {
  const preloaded: any = { ...(opts.state ?? {}) };
  if (opts.signedIn !== undefined) {
    const base = makeStore().getState().auth;
    preloaded.auth = { ...base, user: opts.signedIn, bootstrapped: true };
  }
  const store = makeStore(preloaded);
  const utils = render(
    <Provider store={store}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>
          <Routes>
            <Route path={opts.path ?? "*"} element={ui} />
            <Route path="/login" element={<div>login-page</div>} />
            {/* Redirect targets — skipped when the test itself renders under /app. */}
            {(opts.route ?? "/").startsWith("/app") ? null : <Route path="/app/*" element={<div>app-page</div>} />}
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </Provider>,
  );
  return { store, ...utils };
}
