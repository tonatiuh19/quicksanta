import { CalendarHeart, Gift, LayoutDashboard, Settings, UserRound, Users } from "lucide-react";
import PortalShell, { type NavItem } from "@/components/portal/PortalShell";

/** Workspace nav, split by category (groundwork-style sections). */
export const APP_NAV: NavItem[] = [
  { to: "/app", end: true, labelKey: "nav.dashboard", icon: LayoutDashboard, section: "nav.sectionOverview" },
  { to: "/app/my", labelKey: "nav.myExchanges", icon: Gift, section: "nav.sectionOverview" },
  { to: "/app/events", labelKey: "nav.events", icon: CalendarHeart, roles: ["organizer"], section: "nav.sectionOrganize" },
  { to: "/app/members", labelKey: "nav.members", icon: Users, roles: ["organizer"], section: "nav.sectionOrganize" },
  { to: "/app/settings", labelKey: "nav.workspaceSettings", icon: Settings, roles: ["organizer"], section: "nav.sectionSetup" },
  { to: "/app/profile", labelKey: "nav.profile", icon: UserRound, section: "nav.sectionSetup" },
];

export default function AppLayout() {
  return <PortalShell kind="app" titleKey="shell.workspaceTitle" nav={APP_NAV} tabs={["/app", "/app/my", "/app/events", "/app/members"]} />;
}
