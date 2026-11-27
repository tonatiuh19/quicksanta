import { useTranslation } from "react-i18next";
import type { EmailLogRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { PageHeader, StatusBadge, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";

export default function Emails() {
  const { t, i18n } = useTranslation();
  const columns: DataGridColumn<EmailLogRow>[] = [
    { key: "created_at", label: t("admin.emails.when"), sortable: true, render: (r) => formatDate(r.created_at, i18n.language, true) },
    { key: "to_email", label: t("admin.emails.to"), sortable: true },
    { key: "template", label: t("admin.emails.template"), sortable: true, render: (r) => t(`admin.emails.tpl.${r.template}`, { defaultValue: r.template }) },
    { key: "status", label: t("admin.tenants.col.status"), sortable: true, render: (r) => <StatusBadge value={r.status} /> },
    { key: "tenant_name", label: t("admin.events.tenant"), render: (r) => r.tenant_name ?? "—" },
    { key: "error", label: t("admin.emails.error"), wrap: true, render: (r) => r.error ?? "" },
  ];
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.emails")} subtitle={t("admin.emails.sub")} />
      <ServerGrid<EmailLogRow>
        grid="adminEmails"
        columns={columns}
        rowKey={(r) => r.id}
        filters={[
          { key: "status", label: t("admin.tenants.col.status"), options: ["sent", "failed", "dry_run"].map((v) => ({ value: v, label: t(`status.${v}`) })) },
          { key: "template", label: t("admin.emails.template"), options: ["otp", "invite", "assignment", "link_joined", "contact"].map((v) => ({ value: v, label: t(`admin.emails.tpl.${v}`) })) },
        ]}
      />
    </div>
  );
}
