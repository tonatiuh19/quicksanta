import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarDays, Gift } from "lucide-react";
import { EmptyState, ErrorNote, PageHeader, Spinner, StatusBadge, formatBudget, formatDate } from "@/components/kit";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMyEvents } from "@/store/slices/appSlice";

export default function MyEvents() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { myEvents, loading, error } = useAppSelector((s) => s.app);
  useEffect(() => {
    void dispatch(fetchMyEvents());
  }, [dispatch]);
  return (
    <div className="portal-page">
      <PageHeader title={t("nav.myExchanges")} subtitle={t("my.sub")} />
      <ErrorNote error={error} onRetry={() => void dispatch(fetchMyEvents())} />
      {loading.myEvents && !myEvents.length ? <Spinner label={t("common.loading")} /> : null}
      {!loading.myEvents && !myEvents.length ? <EmptyState title={t("my.none")} body={t("my.noneBody")} /> : null}
      <div className="qs-card-grid">
        {myEvents.map((e) => (
          <button key={e.id} type="button" className="qs-event-card" onClick={() => navigate(`/app/my/${e.public_id}`)}>
            <span className="qs-event-card-icon">
              <Gift size={20} />
            </span>
            <span className="qs-kicker">{e.tenant_name}</span>
            <strong>{e.name}</strong>
            <span className="qs-event-card-meta">
              <CalendarDays size={14} /> {formatDate(e.exchange_date, i18n.language)} · {formatBudget(e.budget_min, e.budget_max, e.currency)}
            </span>
            <StatusBadge value={e.status} />
          </button>
        ))}
      </div>
    </div>
  );
}
