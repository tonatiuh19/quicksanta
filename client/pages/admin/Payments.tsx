import { useTranslation } from "react-i18next";
import { formatMoney, type PaymentRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { PageHeader, StatusBadge, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";

export default function Payments() {
  const { t, i18n } = useTranslation();
  const columns: DataGridColumn<PaymentRow>[] = [
    { key: "created_at", label: t("admin.emails.when"), sortable: true, render: (r) => formatDate(r.created_at, i18n.language, true) },
    { key: "amount", label: t("admin.payments.amount"), sortable: true, render: (r) => <strong>{formatMoney(r.amount_cents, r.currency)}</strong> },
    { key: "status", label: t("admin.tenants.col.status"), sortable: true, render: (r) => <StatusBadge value={r.status} /> },
    { key: "tenant", label: t("admin.events.tenant"), sortable: true, render: (r) => r.tenant_name },
    { key: "event_name", label: t("events.col.name"), render: (r) => r.event_name },
    { key: "payer_email", label: t("admin.payments.payer"), render: (r) => r.payer_email ?? "—" },
    { key: "card", label: t("admin.payments.card"), render: (r) => (r.card_last4 ? `${(r.card_brand ?? "").toUpperCase()} •••• ${r.card_last4}` : "—") },
    { key: "provider_payment_id", label: "Stripe", render: (r) => <code>{r.provider_payment_id}</code> },
  ];
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.payments")} subtitle={t("admin.payments.sub")} />
      <ServerGrid<PaymentRow>
        grid="adminPayments"
        columns={columns}
        rowKey={(r) => r.id}
        filters={[{ key: "status", label: t("admin.tenants.col.status"), options: ["succeeded", "pending", "failed", "refunded"].map((v) => ({ value: v, label: t(`status.${v}`) })) }]}
      />
    </div>
  );
}
