import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2, CalendarHeart, DollarSign, Mail, Shuffle, Users } from "lucide-react";
import { formatMoney } from "@shared/api";
import { Card, ErrorNote, PageHeader, Spinner, StatCard, StatusBadge, formatDate } from "@/components/kit";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchOverview } from "@/store/slices/adminSlice";

export default function Overview() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { overview: o, loading, error } = useAppSelector((s) => s.admin);
  useEffect(() => {
    void dispatch(fetchOverview());
  }, [dispatch]);
  const maxDay = Math.max(1, ...(o?.signups_by_day ?? []).map((d) => Math.max(d.users, d.tenants)));
  const maxType = Math.max(1, ...(o?.events_by_type ?? []).map((x) => x.count));
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.overview.title")} subtitle={t("admin.overview.sub")} />
      <ErrorNote error={error} onRetry={() => void dispatch(fetchOverview())} />
      {loading.overview && !o ? <Spinner label={t("common.loading")} /> : null}
      {o ? (
        <>
          <div className="qs-stats">
            <StatCard label={t("admin.kpi.tenants")} value={o.kpis.tenants} hint={t("admin.kpi.active", { n: o.kpis.active_tenants })} icon={<Building2 size={18} />} />
            <StatCard label={t("admin.kpi.revenue")} value={formatMoney(o.kpis.revenue_cents, "usd")} hint={t("admin.kpi.revenue30", { amount: formatMoney(o.kpis.revenue_30d_cents, "usd"), n: o.kpis.pro_events })} tone="green" icon={<DollarSign size={18} />} />
            <StatCard label={t("admin.kpi.users")} value={o.kpis.users} tone="gold" icon={<Users size={18} />} />
            <StatCard label={t("admin.kpi.events")} value={o.kpis.events} hint={t("admin.kpi.openDrawn", { open: o.kpis.open_events, drawn: o.kpis.drawn_events })} tone="green" icon={<CalendarHeart size={18} />} />
            <StatCard label={t("admin.kpi.participants")} value={o.kpis.participants} tone="red" icon={<Shuffle size={18} />} />
            <StatCard label={t("admin.kpi.emails")} value={o.kpis.emails_7d} hint={t("admin.kpi.failures", { n: o.kpis.email_failures_7d })} tone={o.kpis.email_failures_7d ? "red" : "default"} icon={<Mail size={18} />} />
          </div>
          <div className="qs-two-col">
            <Card title={t("admin.overview.signups")}>
              <div className="qs-bars" role="img" aria-label={t("admin.overview.signups")}>
                {o.signups_by_day.map((d) => (
                  <div key={d.day} className="qs-bar-col" title={`${d.day}: ${d.users} / ${d.tenants}`}>
                    <div className="qs-bar-stack">
                      <span className="qs-bar users" style={{ height: `${(d.users / maxDay) * 100}%` }} />
                      <span className="qs-bar tenants" style={{ height: `${(d.tenants / maxDay) * 100}%` }} />
                    </div>
                    <span className="qs-bar-label">{d.day.slice(8)}</span>
                  </div>
                ))}
              </div>
              <div className="qs-legend">
                <span className="users">{t("admin.kpi.users")}</span>
                <span className="tenants">{t("admin.kpi.tenants")}</span>
              </div>
            </Card>
            <Card title={t("admin.overview.byType")}>
              <ul className="qs-hbars">
                {o.events_by_type.map((x) => (
                  <li key={x.slug}>
                    <span>{t(`services.${x.slug}.name`, { defaultValue: x.name })}</span>
                    <span className="qs-hbar">
                      <span style={{ width: `${(x.count / maxType) * 100}%` }} />
                    </span>
                    <strong>{x.count}</strong>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <div className="qs-two-col">
            <Card title={t("admin.overview.recentTenants")} actions={<Link className="qs-link-btn" to="/admin/tenants">{t("common.viewAll")}</Link>}>
              <ul className="qs-list">
                {o.recent_tenants.map((tn) => (
                  <li key={tn.id} className="is-clickable" onClick={() => navigate(`/admin/tenants?open=${tn.id}`)}>
                    <div>
                      <strong>{tn.name}</strong>
                      <span>
                        {tn.owner_email ?? "—"} · {formatDate(tn.created_at, i18n.language)}
                      </span>
                    </div>
                    <StatusBadge value={tn.status} />
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={t("admin.overview.activity")} actions={<Link className="qs-link-btn" to="/admin/audit">{t("common.viewAll")}</Link>}>
              <ul className="qs-list">
                {o.recent_audit.map((a) => (
                  <li key={a.id}>
                    <div>
                      <strong>{a.action}</strong>
                      <span>
                        {a.actor_email ?? "system"}
                        {a.tenant_name ? ` · ${a.tenant_name}` : ""} · {formatDate(a.created_at, i18n.language, true)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
