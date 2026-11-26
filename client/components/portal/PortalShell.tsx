/**
 * Shared app shell (ported from groundwork PortalShell):
 * - Desktop: dark sidebar with category headings (`section`), account strip, logout.
 * - ≤900px: sticky top bar + bottom tab bar (max 4 + "More") + the full menu as a bottom sheet.
 * Items are filtered by platform permission / tenant role; a heading renders where a section starts,
 * so sections the user can't see vanish with their items.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { platformCan, type PlatformPerm, type TenantRole } from "@shared/api";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe, logout, sessionExpired, switchTenant } from "@/store/slices/authSlice";
import { Brand } from "@/components/kit";

export type NavItem = {
  to: string;
  end?: boolean;
  labelKey: string;
  icon: LucideIcon;
  /** Command Center: required platform permission. */
  perm?: PlatformPerm;
  /** Workspace: tenant roles that see this item. */
  roles?: readonly TenantRole[];
  /** i18n key of the category heading this item sits under. */
  section?: string;
  badge?: number;
};

type Props = {
  kind: "admin" | "app";
  titleKey: string;
  nav: NavItem[];
  /** Phones: preferred bottom-tab paths (max 4). */
  tabs?: string[];
  /** Guard: return false to redirect (e.g. non-platform users out of /admin). */
  allow?: (u: NonNullable<ReturnType<typeof useAuthUser>>) => boolean;
  denyPath?: string;
  headerAction?: ReactNode;
};

function useAuthUser() {
  return useAppSelector((s) => s.auth.user);
}

export function filterNav(nav: NavItem[], platformRole: Parameters<typeof platformCan>[0], tenantRole: TenantRole | null) {
  return nav.filter((i) => (!i.perm || platformCan(platformRole, i.perm)) && (!i.roles || (tenantRole !== null && i.roles.includes(tenantRole))));
}

export default function PortalShell({ kind, titleKey, nav, tabs, allow, denyPath = "/app", headerAction }: Props) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const navId = useId();
  const [navOpen, setNavOpen] = useState(false);
  const { user, bootstrapped, loadingMe } = useAppSelector((s) => s.auth);

  useEffect(() => {
    if (!bootstrapped && !loadingMe) void dispatch(fetchMe());
  }, [bootstrapped, loadingMe, dispatch]);

  useEffect(() => {
    if (bootstrapped && !user && !loadingMe) navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    else if (user && allow && !allow(user)) navigate(denyPath, { replace: true });
  }, [bootstrapped, user, loadingMe, navigate, allow, denyPath, location.pathname]);

  useEffect(() => {
    if (location.hash) return;
    mainRef.current?.scrollTo?.({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname, location.hash]);

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [navOpen]);

  // Only the first load shows the loader: background refreshes (fetchMe after billing / workspace changes)
  // must not unmount the page, or its local state (toasts, open dialogs) is lost.
  if (!bootstrapped || (loadingMe && !user)) {
    return (
      <div className="portal-shell-loading" role="status" aria-live="polite">
        <span className="qs-spinner" aria-hidden />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }
  if (!user || (allow && !allow(user))) return null;

  const active = user.memberships.find((m) => m.tenant_id === user.active_tenant_id) ?? null;
  const visibleNav = filterNav(nav, user.platform_role, active?.role ?? null);
  const tabItems = [
    ...(tabs ?? []).map((to) => visibleNav.find((i) => i.to === to)).filter((i): i is NavItem => Boolean(i)),
    ...visibleNav.filter((i) => !(tabs ?? []).includes(i.to)),
  ].slice(0, 4);
  const closeNav = () => setNavOpen(false);
  const homePath = kind === "admin" ? "/admin" : "/app";
  const initials = (user.full_name || user.email).split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className={`portal-shell portal-shell--${kind}${navOpen ? " is-nav-open" : ""}`}>
      <header className="portal-mobile-bar">
        <Link to={homePath} className="portal-mobile-brand" onClick={closeNav}>
          <Brand compact />
          <span className="portal-mobile-kicker">{t(titleKey)}</span>
        </Link>
        <div className="portal-mobile-bar-actions">{headerAction}</div>
      </header>

      <button type="button" className="portal-nav-overlay" aria-label={t("shell.closeMenu")} tabIndex={navOpen ? 0 : -1} onClick={closeNav} />

      <aside className="portal-sidebar" id={navId} aria-label={t("shell.menu")}>
        <div className="portal-sheet-head">
          <span className="portal-sheet-grip" aria-hidden />
          <strong>{t("shell.menu")}</strong>
          <button type="button" className="portal-sheet-close" onClick={closeNav} aria-label={t("shell.closeMenu")}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <Link to="/" className="portal-sidebar-brand" onClick={closeNav}>
          <Brand inverted />
        </Link>
        <p className="portal-sidebar-kicker">{t(titleKey)}</p>

        {kind === "app" && user.memberships.length > 0 ? (
          <label className="portal-tenant-switch">
            <span>{t("shell.workspace")}</span>
            <select
              value={user.active_tenant_id ?? ""}
              onChange={(e) => {
                void dispatch(switchTenant(Number(e.target.value))).then(() => navigate("/app"));
              }}
              aria-label={t("shell.workspace")}
            >
              {user.memberships.map((m) => (
                <option key={m.tenant_id} value={m.tenant_id}>
                  {m.tenant_name} · {t(`role.${m.role}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {headerAction ? <div className="portal-sidebar-action">{headerAction}</div> : null}

        <nav className={`portal-sidebar-nav${visibleNav.some((i) => i.section) ? " has-sections" : ""}`} aria-label={t(titleKey)}>
          {visibleNav.map((item, idx) => {
            const heading =
              item.section && item.section !== visibleNav[idx - 1]?.section ? (
                <p key={`s-${item.section}`} className="portal-nav-section">
                  <span>{t(item.section)}</span>
                </p>
              ) : null;
            const row = (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={closeNav} className={({ isActive }) => (isActive ? "portal-nav-link is-active" : "portal-nav-link")}>
                <item.icon size={17} strokeWidth={1.7} />
                <span>{t(item.labelKey)}</span>
                {item.badge ? <span className="portal-nav-badge">{item.badge > 99 ? "99+" : item.badge}</span> : null}
              </NavLink>
            );
            return heading ? [heading, row] : row;
          })}
        </nav>

        <div className="portal-sidebar-foot">
          {user.platform_role && kind === "app" ? (
            <Link to="/admin" className="portal-switch-link" onClick={closeNav}>
              {t("shell.openCommandCenter")}
            </Link>
          ) : null}
          {kind === "admin" ? (
            <Link to="/app" className="portal-switch-link" onClick={closeNav}>
              {t("shell.openWorkspace")}
            </Link>
          ) : null}
          <div className="portal-account-strip">
            <Link to={`${homePath}/profile`} className="portal-account-profile" onClick={closeNav}>
              <span className="portal-sidebar-avatar" aria-hidden>
                <span>{initials}</span>
              </span>
              <span className="portal-account-copy">
                <strong>{user.full_name || user.email}</strong>
                <span className="portal-account-email">{user.email}</span>
                <span className="portal-account-role">{user.platform_role && kind === "admin" ? t(`role.${user.platform_role}`) : active ? t(`role.${active.role}`) : ""}</span>
              </span>
            </Link>
          </div>
          <button
            type="button"
            className="portal-logout"
            onClick={async () => {
              closeNav();
              // Even if the request fails, never leave a "half signed out" UI behind.
              const r = await dispatch(logout());
              if (logout.rejected.match(r)) dispatch(sessionExpired());
              navigate("/login");
            }}
          >
            <LogOut size={15} /> {t("shell.logout")}
          </button>
        </div>
      </aside>

      <main className="portal-main" ref={mainRef}>
        <Outlet />
      </main>

      <nav className="portal-tabbar" aria-label={t("shell.quickNav")}>
        {tabItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} onClick={closeNav} className={({ isActive }) => (isActive && !navOpen ? "portal-tab is-active" : "portal-tab")}>
            <span className="portal-tab-icon">
              <item.icon size={21} strokeWidth={1.8} aria-hidden />
            </span>
            <span className="portal-tab-label">{t(item.labelKey)}</span>
          </NavLink>
        ))}
        <button type="button" className={navOpen ? "portal-tab is-active" : "portal-tab"} aria-expanded={navOpen} aria-controls={navId} onClick={() => setNavOpen((v) => !v)}>
          <span className="portal-tab-icon">
            <MoreHorizontal size={21} strokeWidth={1.8} aria-hidden />
          </span>
          <span className="portal-tab-label">{t("shell.more")}</span>
        </button>
      </nav>
    </div>
  );
}
