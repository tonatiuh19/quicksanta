import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ShieldPlus } from "lucide-react";
import { platformCan, type AdminUserRow } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { ErrorNote, PageHeader, StatusBadge, formatDate } from "@/components/kit";
import { Modal } from "@/components/portal/Modal";
import { Button } from "@/components/ui/button";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { grantPlatformRole, updateUserAdmin } from "@/store/slices/adminSlice";

export default function Users() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const me = useAppSelector((s) => s.auth.user)!;
  const [reload, setReload] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const canRoles = platformCan(me.platform_role, "users.roles");

  const change = async (id: number, patch: Record<string, unknown>) => {
    setErr(null);
    const r = await dispatch(updateUserAdmin({ id, patch }));
    if (updateUserAdmin.fulfilled.match(r)) setReload((n) => n + 1);
    else setErr(r.payload ?? "errors.server");
  };

  const columns: DataGridColumn<AdminUserRow>[] = [
    { key: "full_name", label: t("people.col.name"), sortable: true, sticky: true, render: (u) => <strong>{u.full_name || "—"}</strong> },
    { key: "email", label: t("people.col.email"), sortable: true },
    {
      key: "platform_role",
      label: t("admin.users.platformRole"),
      sortable: true,
      render: (u) =>
        canRoles && u.id !== me.id ? (
          <select value={u.platform_role ?? ""} aria-label={t("admin.users.platformRole")} onChange={(e) => void change(u.id, { platform_role: e.target.value || null })}>
            <option value="">{t("admin.users.noRole")}</option>
            <option value="admin">{t("role.admin")}</option>
            <option value="owner">{t("role.owner")}</option>
          </select>
        ) : (
          <StatusBadge value={u.platform_role} labelKey={u.platform_role ? `role.${u.platform_role}` : undefined} />
        ),
    },
    { key: "status", label: t("admin.tenants.col.status"), sortable: true, render: (u) => <StatusBadge value={u.status} /> },
    { key: "tenant_count", label: t("admin.users.workspaces") },
    { key: "last_login_at", label: t("members.lastLogin"), sortable: true, render: (u) => formatDate(u.last_login_at, i18n.language, true) },
    { key: "created_at", label: t("admin.tenants.col.created"), sortable: true, render: (u) => formatDate(u.created_at, i18n.language) },
    {
      key: "actions",
      label: "",
      shrink: true,
      render: (u) =>
        u.id !== me.id && (u.platform_role !== "owner" || me.platform_role === "owner") ? (
          <button className={`qs-link-btn${u.status === "active" ? " danger" : ""}`} onClick={() => void change(u.id, { status: u.status === "active" ? "suspended" : "active" })}>
            {u.status === "active" ? t("admin.users.suspend") : t("admin.users.reactivate")}
          </button>
        ) : null,
    },
  ];

  return (
    <div className="portal-page">
      <PageHeader
        kicker={t("shell.commandCenter")}
        title={t("admin.nav.users")}
        subtitle={t("admin.users.sub")}
        actions={
          canRoles ? (
            <Button className="qs-btn-primary" onClick={() => setGrantOpen(true)}>
              <ShieldPlus /> {t("admin.users.grant")}
            </Button>
          ) : null
        }
      />
      <ErrorNote error={err} />
      <ServerGrid<AdminUserRow>
        grid="adminUsers"
        reloadToken={reload}
        columns={columns}
        rowKey={(u) => u.id}
        filters={[
          { key: "status", label: t("admin.tenants.col.status"), options: ["active", "suspended"].map((v) => ({ value: v, label: t(`status.${v}`) })) },
          { key: "platform_role", label: t("admin.users.platformRole"), options: ["owner", "admin"].map((v) => ({ value: v, label: t(`role.${v}`) })) },
        ]}
      />
      <GrantModal open={grantOpen} onClose={() => setGrantOpen(false)} onDone={() => (setGrantOpen(false), setReload((n) => n + 1))} />
    </div>
  );
}

function GrantModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [f, setF] = useState({ email: "", full_name: "", platform_role: "admin" as "admin" | "owner" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await dispatch(grantPlatformRole(f));
    if (grantPlatformRole.fulfilled.match(r)) {
      setF({ email: "", full_name: "", platform_role: "admin" });
      onDone();
    } else setErr(r.payload ?? "errors.server");
  };
  return (
    <Modal open={open} titleKey="admin.users.grant" onClose={onClose}>
      <form className="qs-form qs-modal-body" onSubmit={submit}>
        <label className="qs-field">
          <span>{t("auth.email")}</span>
          <input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="qs-field">
          <span>{t("auth.yourName")}</span>
          <input required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </label>
        <label className="qs-field">
          <span>{t("admin.users.platformRole")}</span>
          <select value={f.platform_role} onChange={(e) => setF({ ...f, platform_role: e.target.value as any })}>
            <option value="admin">{t("role.admin")}</option>
            <option value="owner">{t("role.owner")}</option>
          </select>
        </label>
        <p className="qs-fine">{t("admin.users.grantHint")}</p>
        <ErrorNote error={err} />
        <div className="qs-modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" className="qs-btn-primary">
            {t("admin.users.grant")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
