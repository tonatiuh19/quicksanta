import { useTranslation } from "react-i18next";
import type { AuditRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { PageHeader, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";

export default function Audit() {
  const { t, i18n } = useTranslation();
  const columns: DataGridColumn<AuditRow>[] = [
    { key: "created_at", label: t("admin.emails.when"), sortable: true, render: (r) => formatDate(r.created_at, i18n.language, true) },
    { key: "action", label: t("admin.audit.action"), sortable: true, render: (r) => <code>{r.action}</code> },
    { key: "actor_email", label: t("admin.audit.actor"), render: (r) => r.actor_email ?? "system" },
    { key: "tenant_name", label: t("admin.events.tenant"), render: (r) => r.tenant_name ?? "—" },
    { key: "entity", label: t("admin.audit.entity"), render: (r) => `${r.entity}${r.entity_id ? ` #${r.entity_id}` : ""}` },
    { key: "meta", label: t("admin.audit.details"), wrap: true, render: (r) => (r.meta ? <code className="qs-code">{JSON.stringify(r.meta)}</code> : "") },
  ];
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.audit")} subtitle={t("admin.audit.sub")} />
      <ServerGrid<AuditRow>
        grid="adminAudit"
        columns={columns}
        rowKey={(r) => r.id}
        filters={[{ key: "entity", label: t("admin.audit.entity"), options: ["user", "tenant", "event", "participant", "member", "event_type"].map((v) => ({ value: v, label: v })) }]}
      />
    </div>
  );
}
