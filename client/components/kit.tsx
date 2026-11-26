/** Small shared UI kit (groundwork kit.tsx subset, QuickSanta-branded). */
import { useEffect, useState, type ReactNode } from "react";
import { Gift, Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { translateApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Brand({ compact = false, inverted = false }: { compact?: boolean; inverted?: boolean }) {
  return (
    <span className={cn("qs-brand", inverted && "qs-brand--inverted", compact && "qs-brand--compact")}>
      <span className="qs-brand-mark" aria-hidden>
        <Gift size={compact ? 16 : 18} strokeWidth={2.2} />
      </span>
      <span className="qs-brand-word">
        Quick<strong>Santa</strong>
      </span>
    </span>
  );
}

export function PageHeader({ title, subtitle, actions, kicker }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <header className="qs-page-header">
      <div className="min-w-0">
        {kicker ? <p className="qs-kicker">{kicker}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="qs-page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="qs-page-actions">{actions}</div> : null}
    </header>
  );
}

export function StatCard({ label, value, hint, tone = "default", icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "red" | "green" | "gold"; icon?: ReactNode }) {
  return (
    <div className={`qs-stat qs-stat--${tone}`}>
      <div className="qs-stat-top">
        <span className="qs-stat-label">{label}</span>
        {icon ? <span className="qs-stat-icon">{icon}</span> : null}
      </div>
      <strong className="qs-stat-value">{value}</strong>
      {hint ? <span className="qs-stat-hint">{hint}</span> : null}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "green", joined: "green", open: "green", sent: "green", drawn: "blue",
  invited: "gold", canceling: "gold", past_due: "red", trialing: "blue", incomplete: "gold", none: "gray", pending_payment: "gold", pending: "gold", succeeded: "green", refunded: "gray", draft: "gray", dry_run: "gray", pro: "blue", enterprise: "purple", free: "gray",
  suspended: "red", failed: "red", declined: "red", cancelled: "red", removed: "gray", archived: "gray", completed: "gray",
  owner: "purple", admin: "blue", organizer: "blue", participant: "gray",
};
export function StatusBadge({ value, labelKey }: { value: string | null | undefined; labelKey?: string }) {
  const { t } = useTranslation();
  if (!value) return <span className="qs-muted">—</span>;
  return <span className={`qs-badge qs-badge--${STATUS_TONE[value] ?? "gray"}`}>{t(labelKey ?? `status.${value}`, { defaultValue: value })}</span>;
}

export function ErrorNote({ error, onRetry, opts }: { error: string | null | undefined; onRetry?: () => void; opts?: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className="qs-error" role="alert">
      <span>{translateApiError(t, error, opts)}</span>
      {onRetry ? (
        <button type="button" className="qs-link-btn" onClick={onRetry}>
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="qs-empty">
      <div className="qs-empty-icon">{icon ?? <Gift size={26} />}</div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="qs-inline-spinner" role="status">
      <Loader2 className="spin" size={16} aria-hidden />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn("qs-card", className)}>
      {title || actions ? (
        <div className="qs-card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Debounced search box (300ms) for server-side grids. */
export function SearchBox({ value, onSearch, placeholder }: { value: string; onSearch: (q: string) => void; placeholder?: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const id = setTimeout(() => onSearch(draft), 300);
    return () => clearTimeout(id);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="qs-search">
      <Search size={16} aria-hidden />
      <input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder ?? t("grid.search")} aria-label={placeholder ?? t("grid.search")} />
    </label>
  );
}

export function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="qs-filter">
      <span className="sr-only">{label}</span>
      <select value={value || "all"} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="all">{t("grid.allOf", { label })}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function formatDate(v: string | null | undefined, lang: string, withTime = false) {
  if (!v) return "—";
  const d = new Date(v.length === 10 ? `${v}T12:00:00Z` : v.replace(" ", "T") + (v.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(lang.startsWith("es") ? "es-MX" : "en-US", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

export function formatBudget(min: number | null, max: number | null, currency: string, lang?: string) {
  if (min == null && max == null) return "—";
  const locale = (lang ?? (typeof document !== "undefined" ? document.documentElement.lang : "")) || undefined;
  const f = (n: number) => n.toLocaleString(locale?.startsWith("es") ? "es-MX" : "en-US", { maximumFractionDigits: 0 });
  if (min != null && max != null) return `${f(min)}–${f(max)} ${currency}`;
  return `${f((min ?? max)!)} ${currency}`;
}
