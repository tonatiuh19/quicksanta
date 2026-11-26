import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import type { AdminTenantRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { ErrorNote, PageHeader, Spinner, StatusBadge, formatDate } from "@/components/kit";
import { SideDrawer } from "@/components/portal/SideDrawer";
import { Button } from "@/components/ui/button";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { platformCan } from "@shared/api";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { closeTenantDetail, fetchTenantDetail, updateTenantAdmin } from "@/store/slices/adminSlice";

export default function Tenants() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const [params, setParams] = useSearchParams();
  const [reload, setReload] = useState(0);
  const openId = Number(params.get("open")) || null;

  useEffect(() => {
    if (openId) void dispatch(fetchTenantDetail(openId));
    else dispatch(closeTenantDetail());
  }, [openId, dispatch]);

  const columns: DataGridColumn<AdminTenantRow>[] = [
    { key: "name", label: t("admin.tenants.col.name"), sortable: true, sticky: true, render: (r) => <strong>{r.name}</strong> },
    { key: "owner_email", label: t("admin.tenants.col.owner") },
    { key: "status", label: t("admin.tenants.col.status"), sortable: true, render: (r) => <StatusBadge value={r.status} /> },
    { key: "plan", label: t("admin.tenants.col.plan"), sortable: true, render: (r) => <StatusBadge value={r.plan} labelKey={`plan.${r.plan}`} /> },
    { key: "member_count", label: t("admin.tenants.col.members"), sortable: true },
    { key: "event_count", label: t("admin.tenants.col.events"), sortable: true },
    { key: "created_at", label: t("admin.tenants.col.created"), sortable: true, render: (r) => formatDate(r.created_at, i18n.language) },
  ];

  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.tenants")} subtitle={t("admin.tenants.sub")} />
      <ServerGrid<AdminTenantRow>
        grid="adminTenants"
        reloadToken={reload}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => setParams({ open: String(r.id) })}
        searchPlaceholder={t("admin.tenants.search")}
        filters={[
          { key: "status", label: t("admin.tenants.col.status"), options: ["active", "suspended", "archived"].map((v) => ({ value: v, label: t(`status.${v}`) })) },
          { key: "plan", label: t("admin.tenants.col.plan"), options: ["free", "pro", "enterprise"].map((v) => ({ value: v, label: t(`plan.${v}`) })) },
        ]}
        mobileCard={(r) => (
          <button type="button" className="qs-mobile-card" onClick={() => setParams({ open: String(r.id) })}>
            <div className="qs-mobile-card-top">
              <strong>{r.name}</strong>
              <StatusBadge value={r.status} />
            </div>
            <span>
              {r.owner_email ?? "—"} · {r.member_count} {t("admin.tenants.col.members").toLowerCase()} · {r.event_count} {t("admin.tenants.col.events").toLowerCase()}
            </span>
          </button>
        )}
      />
      <TenantDrawer open={Boolean(openId)} onClose={() => setParams({})} onChanged={() => setReload((n) => n + 1)} />
    </div>
  );
}

function TenantDrawer({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const me = useAppSelector((s) => s.auth.user)!;
  const { tenantDetail: d, loading, error } = useAppSelector((s) => s.admin);
  const [limits, setLimits] = useState({ max_events: 0, max_participants_per_event: 0 });
  useEffect(() => {
    if (d) setLimits({ max_events: d.tenant.max_events, max_participants_per_event: d.tenant.max_participants_per_event });
  }, [d]);
  const canWrite = platformCan(me.platform_role, "tenants.write");
  const save = async (patch: Record<string, unknown>) => {
    if (!d) return;
    const r = await dispatch(updateTenantAdmin({ id: d.tenant.id, patch }));
    if (updateTenantAdmin.fulfilled.match(r)) onChanged();
  };
  return (
    <SideDrawer open={open} onClose={onClose} title={d?.tenant.name ?? t("common.loading")} subtitle={d?.tenant.slug} icon={<Building2 size={18} />}>
      {loading.tenant && !d ? <Spinner /> : null}
      <ErrorNote error={error} />
      {d ? (
        <div className="qs-drawer-sections">
          <section>
            <h3>{t("admin.tenants.controls")}</h3>
            <div className="qs-form qs-form-grid">
              <label className="qs-field">
                <span>{t("admin.tenants.col.status")}</span>
                <select disabled={!canWrite} value={d.tenant.status} onChange={(e) => void save({ status: e.target.value })}>
                  {["active", "suspended", "archived"].map((v) => (
                    <option key={v} value={v}>
                      {t(`status.${v}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="qs-field">
                <span>{t("admin.tenants.col.plan")}</span>
                <select disabled={!canWrite} value={d.tenant.plan} onChange={(e) => void save({ plan: e.target.value })}>
                  {["free", "pro", "enterprise"].map((v) => (
                    <option key={v} value={v}>
                      {t(`plan.${v}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="qs-field">
                <span>{t("admin.tenants.maxEvents")}</span>
                <input type="number" min={0} disabled={!canWrite} value={limits.max_events} onChange={(e) => setLimits((l) => ({ ...l, max_events: Number(e.target.value) }))} />
              </label>
              <label className="qs-field">
                <span>{t("admin.tenants.maxParticipants")}</span>
                <input type="number" min={2} disabled={!canWrite} value={limits.max_participants_per_event} onChange={(e) => setLimits((l) => ({ ...l, max_participants_per_event: Number(e.target.value) }))} />
              </label>
              {canWrite ? (
                <div className="span-2">
                  <Button variant="outline" disabled={loading.save} onClick={() => void save(limits)}>
                    {t("admin.tenants.saveLimits")}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>
          <section>
            <h3>
              {t("admin.tenants.col.members")} ({d.members.length})
            </h3>
            <ul className="qs-list">
              {d.members.map((m) => (
                <li key={m.id}>
                  <div>
                    <strong>{m.full_name}</strong>
                    <span>{m.email}</span>
                  </div>
                  <StatusBadge value={m.role} labelKey={`role.${m.role}`} />
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>
              {t("admin.tenants.col.events")} ({d.events.length})
            </h3>
            <ul className="qs-list">
              {d.events.map((e) => (
                <li key={e.id}>
                  <div>
                    <strong>{e.name}</strong>
                    <span>
                      {formatDate(e.exchange_date, i18n.language)} · {e.joined_count}/{e.participant_count}
                    </span>
                  </div>
                  <StatusBadge value={e.status} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </SideDrawer>
  );
}
