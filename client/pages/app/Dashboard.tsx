import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarHeart, Gift, Plus, Shuffle, Users } from "lucide-react";
import { Card, EmptyState, ErrorNote, PageHeader, StatCard, StatusBadge, formatBudget, formatDate, Spinner } from "@/components/kit";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchDashboard, fetchMyEvents } from "@/store/slices/appSlice";

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useAppSelector((s) => s.auth.user)!;
  const { dashboard, myEvents, loading, error } = useAppSelector((s) => s.app);
  const active = user.memberships.find((m) => m.tenant_id === user.active_tenant_id);
  const isOrganizer = active?.role === "organizer";

  useEffect(() => {
    if (!active) return;
    void dispatch(fetchDashboard());
    void dispatch(fetchMyEvents());
  }, [dispatch, active?.tenant_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) {
    return (
      <div className="portal-page">
        <EmptyState title={t("dashboard.noWorkspace")} body={t("dashboard.noWorkspaceBody")} action={<Link className="qs-btn qs-btn-primary" to="/start">{t("landing.cta")}</Link>} />
      </div>
    );
  }

  const first = (user.full_name || "").split(" ")[0];
  return (
    <div className="portal-page">
      <PageHeader
        kicker={active.tenant_name}
        title={t("dashboard.hello", { name: first || "👋" })}
        subtitle={t(isOrganizer ? "dashboard.subOrganizer" : "dashboard.subParticipant")}
        actions={
          isOrganizer ? (
            <Link to="/start" className="qs-btn qs-btn-primary">
              <Plus size={16} /> {t("dashboard.newExchange")}
            </Link>
          ) : null
        }
      />
      <ErrorNote error={error} onRetry={() => void dispatch(fetchDashboard())} />
      {loading.dashboard && !dashboard ? <Spinner label={t("common.loading")} /> : null}
      {dashboard && isOrganizer ? (
        <div className="qs-stats">
          <StatCard label={t("dashboard.kpi.events")} value={dashboard.kpis.events} hint={t("dashboard.kpi.limit", { max: dashboard.tenant.max_events })} icon={<CalendarHeart size={18} />} />
          <StatCard label={t("dashboard.kpi.open")} value={dashboard.kpis.open} tone="green" icon={<Gift size={18} />} />
          <StatCard label={t("dashboard.kpi.drawn")} value={dashboard.kpis.drawn} tone="red" icon={<Shuffle size={18} />} />
          <StatCard label={t("dashboard.kpi.people")} value={`${dashboard.kpis.joined}/${dashboard.kpis.participants}`} hint={t("dashboard.kpi.joined")} tone="gold" icon={<Users size={18} />} />
        </div>
      ) : null}

      <div className="qs-two-col">
        {isOrganizer ? (
          <Card title={t("dashboard.upcoming")} actions={<Link className="qs-link-btn" to="/app/events">{t("common.viewAll")}</Link>}>
            {dashboard?.upcoming.length ? (
              <ul className="qs-list">
                {dashboard.upcoming.map((e) => (
                  <li key={e.id} onClick={() => navigate(`/app/events/${e.id}`)} onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && navigate(`/app/events/${e.id}`)} role="link" tabIndex={0} className="is-clickable">
                    <div>
                      <strong>{e.name}</strong>
                      <span>
                        {formatDate(e.exchange_date, i18n.language)} · {formatBudget(e.budget_min, e.budget_max, e.currency)}
                      </span>
                    </div>
                    <StatusBadge value={e.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("dashboard.noUpcoming")} action={<Link to="/start" className="qs-btn qs-btn-primary">{t("dashboard.newExchange")}</Link>} />
            )}
          </Card>
        ) : null}
        <Card title={t("nav.myExchanges")} actions={<Link className="qs-link-btn" to="/app/my">{t("common.viewAll")}</Link>}>
          {myEvents.length ? (
            <ul className="qs-list">
              {myEvents.slice(0, 5).map((e) => (
                <li key={e.id} onClick={() => navigate(`/app/my/${e.public_id}`)} onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && navigate(`/app/my/${e.public_id}`)} role="link" tabIndex={0} className="is-clickable">
                  <div>
                    <strong>{e.name}</strong>
                    <span>{e.tenant_name}</span>
                  </div>
                  <StatusBadge value={e.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="qs-fine">{t("my.none")}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
