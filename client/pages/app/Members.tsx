import { useState } from "react";
import { useTranslation } from "react-i18next";
import ServerGrid from "@/components/ServerGrid";
import { ErrorNote, PageHeader, StatusBadge, formatDate } from "@/components/kit";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { updateMember } from "@/store/slices/appSlice";
import type { MemberRow } from "@/store/slices/grids";

export default function Members() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const me = useAppSelector((s) => s.auth.user)!;
  const [reload, setReload] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const change = async (id: number, patch: { role?: string; remove?: boolean }) => {
    setErr(null);
    try {
      await dispatch(updateMember({ id, ...patch })).unwrap();
      setReload((n) => n + 1);
    } catch (e) {
      setErr(String(e));
    }
  };
  const columns: DataGridColumn<MemberRow>[] = [
    { key: "name", label: t("people.col.name"), sortable: true, sticky: true, render: (m) => <strong>{m.full_name}</strong> },
    { key: "email", label: t("people.col.email"), sortable: true },
    {
      key: "role",
      label: t("members.role"),
      sortable: true,
      render: (m) =>
        m.user_id === me.id ? (
          <StatusBadge value={m.role} labelKey={`role.${m.role}`} />
        ) : (
          <select value={m.role} aria-label={t("members.role")} onChange={(e) => void change(m.id, { role: e.target.value })} onClick={(e) => e.stopPropagation()}>
            <option value="organizer">{t("role.organizer")}</option>
            <option value="participant">{t("role.participant")}</option>
          </select>
        ),
    },
    { key: "last_login_at", label: t("members.lastLogin"), render: (m) => formatDate(m.last_login_at, i18n.language, true) },
    { key: "created_at", label: t("members.since"), sortable: true, render: (m) => formatDate(m.created_at, i18n.language) },
    {
      key: "actions",
      label: "",
      shrink: true,
      render: (m) =>
        m.user_id !== me.id ? (
          <button className="qs-link-btn danger" onClick={() => void change(m.id, { remove: true })}>
            {t("common.remove")}
          </button>
        ) : null,
    },
  ];
  return (
    <div className="portal-page">
      <PageHeader title={t("nav.members")} subtitle={t("members.sub")} />
      <ErrorNote error={err} />
      <ServerGrid<MemberRow>
        grid="appMembers"
        reloadToken={reload}
        columns={columns}
        rowKey={(m) => m.id}
        filters={[{ key: "role", label: t("members.role"), options: ["organizer", "participant"].map((v) => ({ value: v, label: t(`role.${v}`) })) }]}
      />
    </div>
  );
}
