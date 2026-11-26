import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { EventRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { PageHeader, StatusBadge, formatBudget, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppSelector } from "@/store/hooks";

export default function Events() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const types = useAppSelector((s) => s.catalog.items);
  const es = i18n.language.startsWith("es");
  const columns: DataGridColumn<EventRow>[] = [
    { key: "name", label: t("events.col.name"), sortable: true, sticky: true, render: (e) => <strong>{e.name}</strong> },
    { key: "event_type_name", label: t("events.col.type"), render: (e) => t(`services.${e.event_type_slug}.name`, { defaultValue: e.event_type_name }) },
    { key: "status", label: t("events.col.status"), sortable: true, render: (e) => <StatusBadge value={e.status} /> },
    { key: "exchange_date", label: t("events.col.date"), sortable: true, render: (e) => formatDate(e.exchange_date, i18n.language) },
    { key: "participants", label: t("events.col.people"), render: (e) => `${e.joined_count}/${e.participant_count}` },
    { key: "budget", label: t("events.col.budget"), render: (e) => formatBudget(e.budget_min, e.budget_max, e.currency) },
    { key: "created_at", label: t("events.col.created"), sortable: true, render: (e) => formatDate(e.created_at, i18n.language) },
  ];
  return (
    <div className="portal-page">
      <PageHeader title={t("nav.events")} subtitle={t("events.sub")} actions={<Link to="/start" className="qs-btn qs-btn-primary"><Plus size={16} /> {t("dashboard.newExchange")}</Link>} />
      <ServerGrid<EventRow>
        grid="appEvents"
        columns={columns}
        rowKey={(e) => e.id}
        onRowClick={(e) => navigate(`/app/events/${e.id}`)}
        filters={[
          { key: "status", label: t("events.col.status"), options: ["open", "drawn", "completed", "cancelled", "draft"].map((v) => ({ value: v, label: t(`status.${v}`) })) },
          { key: "type", label: t("events.col.type"), options: types.map((x) => ({ value: x.slug, label: es ? x.name_es : x.name_en })) },
        ]}
        mobileCard={(e) => (
          <button type="button" className="qs-mobile-card" onClick={() => navigate(`/app/events/${e.id}`)}>
            <div className="qs-mobile-card-top">
              <strong>{e.name}</strong>
              <StatusBadge value={e.status} />
            </div>
            <span>
              {formatDate(e.exchange_date, i18n.language)} · {e.joined_count}/{e.participant_count} · {formatBudget(e.budget_min, e.budget_max, e.currency)}
            </span>
          </button>
        )}
      />
    </div>
  );
}
