/**
 * Shared API contract (types + small pure helpers) between client/ and api/.
 * api/index.ts may only `import type` from here (Vercel bundles that one file), so the
 * permission matrix below is mirrored inline in api/index.ts. Keep both in sync
 * (api/permissions.test.ts fails if they drift).
 */

// ─── Roles ─────────────────────────────────────────────────────────────────────
/** Platform (Command Center) roles. NULL = regular user. */
export type PlatformRole = "owner" | "admin";
/** Per-tenant roles. */
export type TenantRole = "organizer" | "participant";

export type PlatformPerm =
  | "overview"
  | "tenants.read"
  | "tenants.write"
  | "users.read"
  | "users.write"
  | "users.roles" // grant/revoke platform roles
  | "events.read"
  | "catalog.write"
  | "audit.read"
  | "emails.read"
  | "payments.read"
  | "settings.write";

export const PLATFORM_PERMS: Record<PlatformPerm, PlatformRole[]> = {
  overview: ["owner", "admin"],
  "tenants.read": ["owner", "admin"],
  "tenants.write": ["owner", "admin"],
  "users.read": ["owner", "admin"],
  "users.write": ["owner", "admin"],
  "users.roles": ["owner"],
  "events.read": ["owner", "admin"],
  "catalog.write": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
  "emails.read": ["owner", "admin"],
  "payments.read": ["owner", "admin"],
  "settings.write": ["owner"],
};

export function platformCan(role: PlatformRole | null | undefined, perm: PlatformPerm): boolean {
  return Boolean(role && PLATFORM_PERMS[perm]?.includes(role));
}

export type TenantPerm = "events.manage" | "participants.manage" | "draw.run" | "members.manage" | "events.view_own";

export const TENANT_PERMS: Record<TenantPerm, TenantRole[]> = {
  "events.manage": ["organizer"],
  "participants.manage": ["organizer"],
  "draw.run": ["organizer"],
  "members.manage": ["organizer"],
  "events.view_own": ["organizer", "participant"],
};

export function tenantCan(role: TenantRole | null | undefined, perm: TenantPerm): boolean {
  return Boolean(role && TENANT_PERMS[perm]?.includes(role));
}

// ─── Grid (server-side filter / sort / search / pagination) ────────────────────
export type SortDir = "ASC" | "DESC";

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface GridQuery {
  page: number;
  limit: number;
  sortBy?: string;
  sortDir?: SortDir;
  q?: string;
  /** Whitelisted enum filters, e.g. { status: "active" } ("" / "all" = no filter). */
  filters?: Record<string, string>;
}

export interface GridResponse<T> {
  ok: true;
  items: T[];
  pagination: PaginationInfo;
  /** Optional facet counts, e.g. { active: 10, suspended: 2 }. */
  facets?: Record<string, number>;
}

/** Serialize a GridQuery into the flat query string every grid endpoint accepts. */
export function gridQueryToParams(q: GridQuery): Record<string, string | number> {
  const out: Record<string, string | number> = { page: q.page, limit: q.limit };
  if (q.sortBy) out.sort_by = q.sortBy;
  if (q.sortDir) out.sort_dir = q.sortDir;
  if (q.q?.trim()) out.q = q.q.trim();
  for (const [k, v] of Object.entries(q.filters ?? {})) if (v && v !== "all") out[k] = v;
  return out;
}

// ─── Entities ──────────────────────────────────────────────────────────────────
export type Locale = "en" | "es";
export type TenantStatus = "active" | "suspended" | "archived";
export type TenantPlan = "free" | "pro" | "enterprise";
export type EventStatus = "pending_payment" | "draft" | "open" | "drawn" | "completed" | "cancelled";
export type EventPlan = "free" | "pro";
export type ParticipantStatus = "invited" | "joined" | "declined" | "removed";

export interface Membership {
  tenant_id: number;
  tenant_public_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: TenantStatus;
  role: TenantRole;
}

export interface SessionUser {
  id: number;
  public_id: string;
  email: string;
  full_name: string;
  locale: Locale;
  platform_role: PlatformRole | null;
  memberships: Membership[];
  active_tenant_id: number | null;
}

export interface EventType {
  id: number;
  slug: string;
  name_en: string;
  name_es: string;
  description_en: string;
  description_es: string;
  icon: string;
  uses_draw: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface EventRow {
  id: number;
  public_id: string;
  tenant_id: number;
  event_type_slug: string;
  event_type_name: string;
  name: string;
  description: string | null;
  status: EventStatus;
  plan: EventPlan;
  paid_at: string | null;
  budget_min: number | null;
  budget_max: number | null;
  currency: string;
  exchange_date: string | null;
  rsvp_deadline: string | null;
  location: string | null;
  allow_wishlists: boolean;
  participant_count: number;
  joined_count: number;
  drawn_at: string | null;
  created_at: string;
}

export interface ParticipantRow {
  id: number;
  public_id: string;
  event_id: number;
  name: string;
  email: string;
  status: ParticipantStatus;
  has_wishlist: boolean;
  invited_at: string | null;
  joined_at: string | null;
  created_at: string;
}

export interface ExclusionRow {
  id: number;
  giver_participant_id: number;
  receiver_participant_id: number;
  giver_name: string;
  receiver_name: string;
  bidirectional: boolean;
}

export interface MyAssignment {
  event: EventRow;
  me: { participant_id: number; name: string; wishlist: string | null; status: ParticipantStatus };
  receiver: { name: string; wishlist: string | null } | null;
}

export interface AdminTenantRow {
  id: number;
  public_id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: TenantPlan;
  max_events: number;
  max_participants_per_event: number;
  owner_email: string | null;
  member_count: number;
  event_count: number;
  created_at: string;
}

export interface AdminUserRow {
  id: number;
  public_id: string;
  email: string;
  full_name: string;
  platform_role: PlatformRole | null;
  status: "active" | "suspended";
  tenant_count: number;
  last_login_at: string | null;
  created_at: string;
}

export interface AdminEventRow extends EventRow {
  tenant_name: string;
}

export interface AuditRow {
  id: number;
  tenant_id: number | null;
  tenant_name: string | null;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface EmailLogRow {
  id: number;
  tenant_name: string | null;
  to_email: string;
  template: string;
  status: "sent" | "failed" | "dry_run";
  error: string | null;
  created_at: string;
}

export interface CommandCenterOverview {
  kpis: {
    tenants: number;
    active_tenants: number;
    users: number;
    events: number;
    open_events: number;
    drawn_events: number;
    participants: number;
    emails_7d: number;
    email_failures_7d: number;
    revenue_cents: number;
    revenue_30d_cents: number;
    pro_events: number;
  };
  signups_by_day: Array<{ day: string; tenants: number; users: number }>;
  events_by_type: Array<{ slug: string; name: string; count: number }>;
  recent_tenants: AdminTenantRow[];
  recent_audit: AuditRow[];
}

export interface TenantDashboard {
  tenant: { id: number; name: string; slug: string; plan: TenantPlan; max_events: number; max_participants_per_event: number };
  kpis: { events: number; open: number; drawn: number; participants: number; joined: number };
  upcoming: EventRow[];
}

// ─── Wizard ────────────────────────────────────────────────────────────────────
export interface WizardParticipant {
  name: string;
  email: string;
}

export interface WizardExclusion {
  /** People referenced by email; "me" = the organizer (their email may be unknown before sign-in). */
  a: string;
  b: string;
  bidirectional: boolean;
}

export interface WizardLaunchInput {
  eventTypeSlug: string;
  name: string;
  description?: string;
  exchangeDate?: string | null;
  rsvpDeadline?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency: string;
  location?: string | null;
  allowWishlists: boolean;
  organizerName: string;
  includeMe: boolean;
  participants: WizardParticipant[];
  exclusions: WizardExclusion[];
  sendInvites: boolean;
  tenantName?: string;
  plan?: EventPlan;
}

export interface WizardLaunchResult {
  ok: true;
  tenant_id: number;
  event_id: number;
  event_public_id: string;
  invited: number;
  /** Pro exchange created in `pending_payment`: pay via /app/events/:id/checkout to open it. */
  payment_required?: boolean;
}

export interface PricingInfo {
  free_max_participants: number;
  pro_max_participants: number;
  pro_price_cents: number;
  pro_currency: string;
}

export interface CheckoutSession {
  client_secret: string | null;
  payment_intent_id: string;
  amount_cents: number;
  currency: string;
}

export interface PaymentRow {
  id: number;
  amount_cents: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  card_brand: string | null;
  card_last4: string | null;
  provider_payment_id: string;
  tenant_name: string;
  event_name: string;
  payer_email: string | null;
  created_at: string;
}

export function formatMoney(cents: number, currency: string, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

// ─── Pure helpers used on both sides ───────────────────────────────────────────
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

/**
 * Parse a pasted participant list. Accepts lines like:
 *   "Ana Pérez <ana@x.com>", "ana@x.com", "Ana Pérez, ana@x.com", "Ana Pérez;ana@x.com", "Ana\tana@x.com"
 */
export function parseParticipantLines(text: string): { valid: WizardParticipant[]; invalid: string[] } {
  const valid: WizardParticipant[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let name = "";
    let email = "";
    const angle = line.match(/^(.*)<([^>]+)>\s*$/);
    if (angle) {
      name = angle[1].trim().replace(/^"|"$/g, "");
      email = angle[2];
    } else {
      const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
      const emailPart = parts.find((p) => EMAIL_RE.test(p));
      if (emailPart) {
        email = emailPart;
        name = parts.filter((p) => p !== emailPart).join(" ");
      } else {
        const m = line.match(/(\S+@\S+)/);
        if (m) {
          email = m[1];
          name = line.replace(m[1], "").trim();
        }
      }
    }
    email = normalizeEmail(email);
    if (!EMAIL_RE.test(email)) {
      invalid.push(line);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    if (!name) name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    valid.push({ name: name.slice(0, 120), email });
  }
  return { valid, invalid };
}
