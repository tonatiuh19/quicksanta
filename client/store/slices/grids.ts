import type { LeadRow, PaymentRow, AdminEventRow, AdminTenantRow, AdminUserRow, AuditRow, EmailLogRow, EventRow, ParticipantRow } from "@shared/api";
import { createGridSlice } from "./gridSlice";

export type MemberRow = { id: number; user_id: number; full_name: string; email: string; role: "organizer" | "participant"; last_login_at: string | null; created_at: string };

/** Every server-side grid in the app. Add one line here for a new grid. */
export const grids = {
  adminTenants: createGridSlice<AdminTenantRow>("grid/adminTenants", "/admin/tenants", { sortBy: "created_at" }),
  adminUsers: createGridSlice<AdminUserRow>("grid/adminUsers", "/admin/users", { sortBy: "created_at" }),
  adminEvents: createGridSlice<AdminEventRow>("grid/adminEvents", "/admin/events", { sortBy: "created_at" }),
  adminAudit: createGridSlice<AuditRow>("grid/adminAudit", "/admin/audit", { sortBy: "id", limit: 50 }),
  adminPayments: createGridSlice<PaymentRow>("grid/adminPayments", "/admin/payments", { sortBy: "id" }),
  adminLeads: createGridSlice<LeadRow>("grid/adminLeads", "/admin/leads", { sortBy: "created_at" }),
  adminEmails: createGridSlice<EmailLogRow>("grid/adminEmails", "/admin/emails", { sortBy: "id", limit: 50 }),
  appEvents: createGridSlice<EventRow>("grid/appEvents", "/app/events", { sortBy: "created_at" }),
  appParticipants: createGridSlice<ParticipantRow>("grid/appParticipants", (eventId: number) => `/app/events/${eventId}/participants`, { sortBy: "name", sortDir: "ASC", limit: 50 }),
  appMembers: createGridSlice<MemberRow>("grid/appMembers", "/app/members", { sortBy: "name", sortDir: "ASC" }),
};

export type GridKey = keyof typeof grids;
export const gridReducers = Object.fromEntries(Object.entries(grids).map(([k, g]) => [k, g.reducer])) as { [K in GridKey]: (typeof grids)[K]["reducer"] };
