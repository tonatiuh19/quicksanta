/**
 * Command Center → Leads: Enterprise inquiries from the landing-page contact form.
 * Server-side grid (search / filter / sort / paginate in SQL); status inline, notes in a modal.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail, NotebookPen } from "lucide-react";
import type { LeadRow, LeadStatus } from "@shared/api";
import ServerGrid from "@/components/ServerGrid";
import { ErrorNote, PageHeader, formatDate } from "@/components/kit";
import { Modal } from "@/components/portal/Modal";
import { Button } from "@/components/ui/button";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppDispatch } from "@/store/hooks";
import { updateLead } from "@/store/slices/adminSlice";

const STATUSES: LeadStatus[] = ["new", "contacted", "won", "lost"];
const SIZES = ["lt50", "50_100", "100_500", "500_plus"] as const;

export default function Leads() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notesFor, setNotesFor] = useState<LeadRow | null>(null);
  const [notes, setNotes] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const save = async (id: number, patch: { status?: string; notes?: string | null }) => {
    setError(null);
    try {
      await dispatch(updateLead({ id, patch })).unwrap();
      setReload((r) => r + 1);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const statusSelect = (r: LeadRow) => (
    <select className={`qs-lead-status is-${r.status}`} aria-label={t("admin.leads.statusFor", { name: r.name })} value={r.status} onClick={(e) => e.stopPropagation()} onChange={(e) => void save(r.id, { status: e.target.value })}>
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {t(`admin.leads.status.${s}`)}
        </option>
      ))}
    </select>
  );
  const notesBtn = (r: LeadRow) => (
    <button type="button" className="qs-icon-btn" aria-label={t("admin.leads.notesFor", { name: r.name })} title={r.notes ?? t("admin.leads.notes")} onClick={(e) => (e.stopPropagation(), setNotesFor(r), setNotes(r.notes ?? ""))}>
      <NotebookPen size={15} />
      {r.notes ? <span className="qs-dot" aria-hidden /> : null}
    </button>
  );

  const columns: DataGridColumn<LeadRow>[] = [
    { key: "created_at", label: t("admin.emails.when"), sortable: true, render: (r) => formatDate(r.created_at, i18n.language, true) },
    {
      key: "name",
      label: t("admin.leads.col.contact"),
      sortable: true,
      render: (r) => (
        <span className="qs-lead-contact">
          <strong>{r.name}</strong>
          <a href={`mailto:${r.email}?subject=${encodeURIComponent("QuickSanta Enterprise")}`} onClick={(e) => e.stopPropagation()}>
            <Mail size={13} /> {r.email}
          </a>
        </span>
      ),
    },
    { key: "company", label: t("admin.leads.col.company"), sortable: true, render: (r) => r.company ?? "—" },
    { key: "team_size", label: t("admin.leads.col.size"), sortable: true, render: (r) => t(`contact.sizes.${r.team_size}`) },
    { key: "message", label: t("admin.leads.col.message"), wrap: true, render: (r) => r.message ?? "—" },
    { key: "status", label: t("admin.tenants.col.status"), sortable: true, render: statusSelect },
    { key: "handled_by_name", label: t("admin.leads.col.handledBy"), render: (r) => r.handled_by_name ?? "—" },
    { key: "actions", label: "", shrink: true, render: notesBtn },
  ];

  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.leads")} subtitle={t("admin.leads.sub")} />
      <ErrorNote error={error} />
      <ServerGrid<LeadRow>
        grid="adminLeads"
        reloadToken={reload}
        columns={columns}
        rowKey={(r) => r.id}
        filters={[
          { key: "status", label: t("admin.tenants.col.status"), options: STATUSES.map((v) => ({ value: v, label: t(`admin.leads.status.${v}`) })) },
          { key: "team_size", label: t("admin.leads.col.size"), options: SIZES.map((v) => ({ value: v, label: t(`contact.sizes.${v}`) })) },
        ]}
        mobileCard={(r) => (
          <div className="qs-mobile-card">
            <div className="qs-mobile-card-top">
              <strong>{r.company || r.name}</strong>
              {statusSelect(r)}
            </div>
            <span>
              {r.name} · <a href={`mailto:${r.email}`}>{r.email}</a>
            </span>
            <span>
              {t(`contact.sizes.${r.team_size}`)} · {formatDate(r.created_at, i18n.language)}
            </span>
            {r.message ? <p className="qs-fine">{r.message}</p> : null}
            {notesBtn(r)}
          </div>
        )}
      />
      <Modal open={notesFor !== null} titleKey="admin.leads.notes" onClose={() => setNotesFor(null)} initialFocusRef={notesRef}>
        <div className="qs-form">
          <p className="qs-fine">{notesFor ? `${notesFor.name} · ${notesFor.company ?? notesFor.email}` : ""}</p>
          <textarea ref={notesRef} rows={5} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={t("admin.leads.notes")} />
          <Button className="qs-btn-primary" onClick={() => notesFor && void save(notesFor.id, { notes: notes.trim() || null }).then((ok) => ok && setNotesFor(null))}>
            {t("common.save")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
