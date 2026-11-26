import { useTranslation } from "react-i18next";
import type { AdminEventRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { PageHeader, StatusBadge, formatBudget, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppSelector } from "@/store/hooks";

export default function AdminEvents() {
  const { t, i18n } = useTranslation();
  const types = useAppSelector((s) => s.catalog.items);
  const es = i18n.language.startsWith("es");
  const columns: DataGridColumn<AdminEventRow>[] = [
    { key: "name", label: t("events.col.name"), sortable: true, sticky: true, render: (e) => <strong>{e.name}</strong> },
    { key: "tenant", label: t("admin.events.tenant"), sortable: true, render: (e) => e.tenant_name },
    { key: "type", label: t("events.col.type"), render: (e) => t(`services.${e.event_type_slug}.name`, { defaultValue: e.event_type_name }) },
    { key: "status", label: t("events.col.status"), sortable: true, render: (e) => <StatusBadge value={e.status} /> },
    { key: "people", label: t("events.col.people"), render: (e) => `${e.joined_count}/${e.participant_count}` },
    { key: "budget", label: t("events.col.budget"), render: (e) => formatBudget(e.budget_min, e.budget_max, e.currency) },
    { key: "exchange_date", label: t("events.col.date"), sortable: true, render: (e) => formatDate(e.exchange_date, i18n.language) },
    { key: "created_at", label: t("events.col.created"), sortable: true, render: (e) => formatDate(e.created_at, i18n.language) },
  ];
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.events")} subtitle={t("admin.events.sub")} />
      <ServerGrid<AdminEventRow>
        grid="adminEvents"
        columns={columns}
        rowKey={(e) => e.id}
        filters={[
          { key: "status", label: t("events.col.status"), options: ["open", "drawn", "completed", "cancelled", "draft"].map((v) => ({ value: v, label: t(`status.${v}`) })) },
          { key: "type", label: t("events.col.type"), options: types.map((x) => ({ value: x.slug, label: es ? x.name_es : x.name_en })) },
        ]}
      />
    </div>
  );
}
