import { Building2, CalendarHeart, CreditCard, Gauge, History, Layers, Mail, Settings, UserRound, Users } from "lucide-react";
import PortalShell, { type NavItem } from "@/components/portal/PortalShell";

/** Command Center nav, split by category like groundwork's AdminLayout. Items list in group order. */
export const ADMIN_NAV: NavItem[] = [
  { to: "/admin", end: true, labelKey: "admin.nav.overview", icon: Gauge, perm: "overview", section: "admin.nav.sectionOverview" },
  { to: "/admin/tenants", labelKey: "admin.nav.tenants", icon: Building2, perm: "tenants.read", section: "admin.nav.sectionTenants" },
  { to: "/admin/users", labelKey: "admin.nav.users", icon: Users, perm: "users.read", section: "admin.nav.sectionTenants" },
  { to: "/admin/events", labelKey: "admin.nav.events", icon: CalendarHeart, perm: "events.read", section: "admin.nav.sectionActivity" },
  { to: "/admin/payments", labelKey: "admin.nav.payments", icon: CreditCard, perm: "payments.read", section: "admin.nav.sectionActivity" },
  { to: "/admin/emails", labelKey: "admin.nav.emails", icon: Mail, perm: "emails.read", section: "admin.nav.sectionActivity" },
  { to: "/admin/audit", labelKey: "admin.nav.audit", icon: History, perm: "audit.read", section: "admin.nav.sectionActivity" },
  { to: "/admin/catalog", labelKey: "admin.nav.catalog", icon: Layers, perm: "catalog.write", section: "admin.nav.sectionPlatform" },
  { to: "/admin/settings", labelKey: "admin.nav.settings", icon: Settings, perm: "overview", section: "admin.nav.sectionPlatform" },
  { to: "/admin/profile", labelKey: "nav.profile", icon: UserRound, section: "admin.nav.sectionPlatform" },
];

export default function AdminLayout() {
  return (
    <PortalShell
      kind="admin"
      titleKey="shell.commandCenter"
      nav={ADMIN_NAV}
      tabs={["/admin", "/admin/tenants", "/admin/users", "/admin/events"]}
      allow={(u) => Boolean(u.platform_role)}
      denyPath="/app"
    />
  );
}
