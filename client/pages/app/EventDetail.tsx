import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Ban, CreditCard, Sparkles, CheckCircle2, Eye, MailPlus, Plus, RotateCcw, Send, Shuffle, Trash2, UserMinus, X } from "lucide-react";
import { parseParticipantLines, type ParticipantRow } from "@shared/api";
import { Card, ErrorNote, PageHeader, StatCard, StatusBadge, Spinner, formatBudget, formatDate } from "@/components/kit";
import ServerGrid from "@/components/ServerGrid";
import { Modal } from "@/components/portal/Modal";
import CheckoutCard from "@/components/billing/CheckoutCard";
import { formatMoney } from "@shared/api";
import { Button } from "@/components/ui/button";
import type { DataGridColumn } from "@/components/ui/data-grid";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  addExclusion, addParticipants, fetchEventDetail, fetchEventPeople, removeExclusion, resendInvite, resetDraw, runDraw, updateEvent, updateParticipant,
} from "@/store/slices/appSlice";

type Tab = "people" | "rules" | "settings";

export default function EventDetail() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const { detail, loading, error } = useAppSelector((s) => s.app);
  const [tab, setTab] = useState<Tab>("people");
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<null | "draw" | "reset" | "cancel">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const me = useAppSelector((s) => s.auth.user);

  const [busyRow, setBusyRow] = useState<number | null>(null);
  const rowAct = async (rowId: number, p: Promise<any>, okKey: string) => {
    if (busyRow) return;
    setBusyRow(rowId);
    try {
      await act(p, okKey);
    } finally {
      setBusyRow(null);
    }
  };
  const refresh = () => {
    void dispatch(fetchEventDetail(id));
    setReload((n) => n + 1);
  };
  useEffect(() => {
    void dispatch(fetchEventDetail(id));
  }, [dispatch, id]);

  const act = async (p: Promise<any>, okKey: string, opts?: Record<string, unknown>) => {
    setActionError(null);
    try {
      const r = await (p as any).unwrap();
      setToast(String(t(okKey, { ...(opts ?? {}), ...(typeof r === "object" ? r : {}) })));
      refresh();
      return true;
    } catch (e) {
      setActionError(String(e));
      return false;
    }
  };

  if (!detail || detail.event.id !== id) {
    return <div className="portal-page">{loading.detail ? <Spinner label={t("common.loading")} /> : <ErrorNote error={error} onRetry={refresh} />}</div>;
  }
  const { event, uses_draw, exclusions, assignments, pricing, tenant_plan, max_participants } = detail;
  const locked = event.status !== "open";
  const canUpgrade = tenant_plan === "free" && event.plan === "free" && (event.status === "open" || event.status === "pending_payment");
  const price = formatMoney(pricing.pro_price_cents, pricing.pro_currency, i18n.language.startsWith("es") ? "es-MX" : "en-US");

  const columns: DataGridColumn<ParticipantRow>[] = [
    { key: "name", label: t("people.col.name"), sortable: true, sticky: true, render: (p) => <strong>{p.name}</strong> },
    { key: "email", label: t("people.col.email"), sortable: true },
    { key: "status", label: t("people.col.status"), sortable: true, render: (p) => <StatusBadge value={p.status} /> },
    { key: "has_wishlist", label: t("people.col.wishlist"), render: (p) => (p.has_wishlist ? "✓" : "—") },
    { key: "joined_at", label: t("people.col.joined"), sortable: true, render: (p) => formatDate(p.joined_at, i18n.language) },
    {
      key: "actions",
      label: "",
      shrink: true,
      render: (p) => (
        <div className="qs-row-actions" onClick={(e) => e.stopPropagation()}>
          {p.status === "invited" ? (
            <button className="qs-icon-btn" disabled={busyRow === p.id} title={t("people.resend")} aria-label={t("people.resend")} onClick={() => void rowAct(p.id, dispatch(resendInvite({ eventId: id, id: p.id })), "people.resent")}>
              <Send size={15} />
            </button>
          ) : null}
          {!locked && p.status !== "removed" ? (
            <button className="qs-icon-btn danger" disabled={busyRow === p.id} title={t("people.remove")} aria-label={t("people.remove")} onClick={() => void rowAct(p.id, dispatch(updateParticipant({ eventId: id, id: p.id, patch: { status: "removed" } })), "people.removed")}>
              <UserMinus size={15} />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="portal-page">
      <Link to="/app/events" className="qs-back">
        <ArrowLeft size={15} /> {t("nav.events")}
      </Link>
      <PageHeader
        kicker={event.custom?.name ?? t(`services.${event.event_type_slug}.name`, { defaultValue: event.event_type_name })}
        title={
          <>
            {event.name} <StatusBadge value={event.status} />
          </>
        }
        subtitle={`${formatDate(event.exchange_date, i18n.language)} · ${formatBudget(event.budget_min, event.budget_max, event.currency)}${event.location ? ` · ${event.location}` : ""}`}
        actions={
          <>
            {uses_draw && event.status === "open" ? (
              <Button className="qs-btn-primary" onClick={() => setConfirm("draw")}>
                <Shuffle /> {t("event.draw")}
              </Button>
            ) : null}
            {event.status === "drawn" ? (
              <>
                <Button variant="outline" onClick={() => setConfirm("reset")}>
                  <RotateCcw /> {t("event.resetDraw")}
                </Button>
                <Button variant="outline" onClick={() => void act(dispatch(updateEvent({ id, patch: { status: "completed" } })), "event.completedOk")}>
                  <CheckCircle2 /> {t("event.complete")}
                </Button>
              </>
            ) : null}
            {event.status === "open" ? (
              <Button variant="ghost" onClick={() => setConfirm("cancel")}>
                <Ban /> {t("event.cancel")}
              </Button>
            ) : null}
          </>
        }
      />
      {toast ? (
        <div className="qs-toast" role="status">
          <span>{toast}</span>
          <button className="qs-icon-btn" aria-label={t("common.close")} onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      <ErrorNote error={actionError} opts={{ min: 3 }} />

      {event.status === "pending_payment" ? (
        <div className="qs-pro-banner is-pending">
          <CreditCard size={20} />
          <div>
            <strong>{t("checkout.pendingTitle")}</strong>
            <span>{t("checkout.pendingBody", { price })}</span>
          </div>
          <Button className="qs-btn-primary" onClick={() => setPayOpen(true)}>
            {t("checkout.payNow", { price })}
          </Button>
        </div>
      ) : canUpgrade ? (
        <div className="qs-pro-banner">
          <Sparkles size={20} />
          <div>
            <strong>{t("checkout.upgradeTitle", { used: event.participant_count, max: max_participants })}</strong>
            <span>{t("checkout.upgradeBody", { count: pricing.pro_max_participants, price })}</span>
          </div>
          <Button variant="outline" onClick={() => setPayOpen(true)}>
            {t("checkout.upgrade")}
          </Button>
        </div>
      ) : tenant_plan === "pro" || event.plan === "pro" ? (
        <p className="qs-pro-chip">
          <Sparkles size={14} /> {t("checkout.proActive", { max: max_participants })}
        </p>
      ) : null}
      {actionError === "errors.needsPro" && canUpgrade ? (
        <Button className="qs-btn-primary qs-mb" onClick={() => setPayOpen(true)}>
          <Sparkles /> {t("checkout.upgrade")}
        </Button>
      ) : null}

      <Modal open={payOpen} titleKey="checkout.modalTitle" onClose={() => setPayOpen(false)}>
        <div className="qs-modal-body">
          <CheckoutCard
            mode="subscribe"
            label={me?.memberships.find((m) => m.tenant_id === me.active_tenant_id)?.tenant_name ?? event.name}
            amountCents={pricing.pro_price_cents}
            currency={pricing.pro_currency}
            payerName={me?.full_name}
            onDone={() => {
              setPayOpen(false);
              setToast(t("billing.subscribedToast"));
              refresh();
            }}
          />
        </div>
      </Modal>

      <div className="qs-stats">
        <StatCard label={t("event.kpi.people")} value={`${event.participant_count}/${max_participants}`} />
        <StatCard label={t("event.kpi.joined")} value={event.joined_count} tone="green" />
        {uses_draw ? <StatCard label={t("event.kpi.rules")} value={exclusions.length} tone="gold" /> : null}
        {event.status === "drawn" ? <StatCard label={t("event.kpi.revealed")} value={`${assignments.viewed}/${assignments.total}`} tone="red" icon={<Eye size={18} />} /> : null}
      </div>

      <div className="qs-tabs" role="tablist">
        {(["people", ...(uses_draw ? ["rules"] : []), "settings"] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "is-active" : ""} onClick={() => setTab(k)}>
            {t(`event.tabs.${k}`)}
          </button>
        ))}
      </div>

      {tab === "people" ? (
        <>
          {!locked ? <AddPeople eventId={id} onDone={(r) => (setToast(String(t("people.addedToast", r))), refresh())} onNeedsPro={canUpgrade ? () => setPayOpen(true) : undefined} /> : null}
          <ServerGrid<ParticipantRow>
            grid="appParticipants"
            pathArg={id}
            reloadToken={reload}
            columns={columns}
            rowKey={(p) => p.id}
            filters={[{ key: "status", label: t("people.col.status"), options: ["invited", "joined", "declined", "removed"].map((v) => ({ value: v, label: t(`status.${v}`) })) }]}
            mobileCard={(p) => (
              <div className="qs-mobile-card">
                <div className="qs-mobile-card-top">
                  <strong>{p.name}</strong>
                  <StatusBadge value={p.status} />
                </div>
                <span>{p.email}</span>
                {columns[columns.length - 1].render!(p, 0)}
              </div>
            )}
          />
        </>
      ) : null}

      {tab === "rules" ? <RulesTab eventId={id} locked={locked} onChange={refresh} onError={setActionError} /> : null}
      {tab === "settings" ? <SettingsTab onSaved={() => setToast(t("common.saved"))} onError={setActionError} /> : null}

      <Modal open={confirm !== null} titleKey={confirm ? `event.confirm.${confirm}.title` : "common.confirm"} onClose={() => setConfirm(null)}>
        <p className="qs-modal-body">{confirm ? t(`event.confirm.${confirm}.body`, { count: event.participant_count }) : null}</p>
        <div className="qs-modal-actions">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            className={confirm === "draw" ? "qs-btn-primary" : "qs-btn-danger"}
            disabled={loading.busy}
            onClick={async () => {
              const which = confirm;
              setConfirm(null);
              if (which === "draw") await act(dispatch(runDraw(id)), "event.drawnOk");
              if (which === "reset") await act(dispatch(resetDraw(id)), "event.resetOk");
              if (which === "cancel") await act(dispatch(updateEvent({ id, patch: { status: "cancelled" } })), "event.cancelledOk");
            }}
          >
            {t(`event.confirm.${confirm ?? "draw"}.cta`)}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function AddPeople({ eventId, onDone, onNeedsPro }: { eventId: number; onDone: (r: { added: number; invited: number; skipped: number }) => void; onNeedsPro?: () => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { valid, invalid } = parseParticipantLines(text);
    if (!valid.length) return setErr("validation.email");
    setBusy(true);
    try {
      const r = await dispatch(addParticipants({ id: eventId, participants: valid, send_invites: true })).unwrap();
      setText(invalid.join("\n"));
      setErr(invalid.length ? "people.someInvalid" : null);
      if (!invalid.length) setOpen(false);
      onDone(r);
    } catch (e) {
      setErr(String(e));
      if (String(e) === "errors.needsPro") onNeedsPro?.();
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="qs-row qs-mb">
        <Button variant="outline" onClick={() => setOpen(true)}>
          <MailPlus /> {t("people.addAndInvite")}
        </Button>
      </div>
    );
  return (
    <form className="qs-card qs-form qs-mb" onSubmit={submit}>
      <label className="qs-field">
        <span>{t("wizard.people.pasteList")}</span>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Ana Pérez <ana@mail.com>\nbob@mail.com"} autoFocus />
      </label>
      <ErrorNote error={err} />
      <div className="qs-row">
        <Button type="submit" className="qs-btn-primary" disabled={busy}>
          <Plus /> {t("people.addAndInvite")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function RulesTab({ eventId, locked, onChange, onError }: { eventId: number; locked: boolean; onChange: () => void; onError: (e: string | null) => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const detail = useAppSelector((s) => s.app.detail)!;
  const peopleState = useAppSelector((s) => s.app.people);
  const people = peopleState?.eventId === eventId ? peopleState.people : [];
  useEffect(() => {
    void dispatch(fetchEventPeople(eventId));
  }, [dispatch, eventId, detail.event.participant_count]);
  const [a, setA] = useState<number>(0);
  const [b, setB] = useState<number>(0);
  const [both, setBoth] = useState(true);
  return (
    <Card title={t("wizard.rules.title")}>
      <p className="qs-fine">{t("wizard.rules.sub")}</p>
      {!locked ? (
        people.length >= 2 ? (
          <div className="qs-rule-builder">
            <select value={a} onChange={(e) => setA(Number(e.target.value))} aria-label={t("wizard.rules.giver")}>
              <option value={0}>—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="qs-rule-arrow">{both ? "⇄" : "→"}</span>
            <select value={b} onChange={(e) => setB(Number(e.target.value))} aria-label={t("wizard.rules.receiver")}>
              <option value={0}>—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label className="qs-switch">
              <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
              <span>{t("wizard.rules.bothWays")}</span>
            </label>
            <Button
              variant="outline"
              disabled={!a || !b || a === b}
              onClick={async () => {
                onError(null);
                try {
                  await dispatch(addExclusion({ eventId, giver_participant_id: a, receiver_participant_id: b, bidirectional: both })).unwrap();
                  onChange();
                } catch (e) {
                  onError(String(e));
                }
              }}
            >
              <Plus /> {t("wizard.rules.add")}
            </Button>
          </div>
        ) : (
          <p className="qs-fine">{t("event.rulesNeedPeople")}</p>
        )
      ) : null}
      <ul className="qs-rules">
        {detail.exclusions.map((x) => (
          <li key={x.id}>
            <span>
              <strong>{x.giver_name}</strong> {x.bidirectional ? "⇄" : "→"} <strong>{x.receiver_name}</strong>
            </span>
            {!locked ? (
              <button className="qs-icon-btn" aria-label={t("common.remove")} onClick={() => void dispatch(removeExclusion({ eventId, id: x.id })).then(onChange)}>
                <Trash2 size={15} />
              </button>
            ) : null}
          </li>
        ))}
        {!detail.exclusions.length ? <li className="qs-fine">{t("wizard.rules.none")}</li> : null}
      </ul>
    </Card>
  );
}

function SettingsTab({ onSaved, onError }: { onSaved: () => void; onError: (e: string | null) => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const event = useAppSelector((s) => s.app.detail!.event);
  const [f, setF] = useState({
    name: event.name,
    exchange_date: event.exchange_date ?? "",
    location: event.location ?? "",
    budget_min: event.budget_min ?? "",
    budget_max: event.budget_max ?? "",
    description: event.description ?? "",
    allow_wishlists: event.allow_wishlists,
  });
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form
      className="qs-card qs-form qs-form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        onError(null);
        try {
          await dispatch(
            updateEvent({
              id: event.id,
              patch: {
                name: f.name,
                exchange_date: f.exchange_date || null,
                location: f.location || null,
                budget_min: f.budget_min === "" ? null : Number(f.budget_min),
                budget_max: f.budget_max === "" ? null : Number(f.budget_max),
                description: f.description || null,
                allow_wishlists: f.allow_wishlists,
              },
            }),
          ).unwrap();
          onSaved();
        } catch (err) {
          onError(String(err));
        }
      }}
    >
      <label className="qs-field span-2">
        <span>{t("wizard.details.name")}</span>
        <input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={140} />
      </label>
      <label className="qs-field">
        <span>{t("wizard.details.date")}</span>
        <input type="date" value={f.exchange_date} onChange={(e) => set("exchange_date", e.target.value)} />
      </label>
      <label className="qs-field">
        <span>{t("wizard.details.location")}</span>
        <input value={f.location} onChange={(e) => set("location", e.target.value)} maxLength={200} />
      </label>
      <label className="qs-field">
        <span>{t("wizard.details.min")}</span>
        <input type="number" min={0} value={f.budget_min} onChange={(e) => set("budget_min", e.target.value)} />
      </label>
      <label className="qs-field">
        <span>{t("wizard.details.max")}</span>
        <input type="number" min={0} value={f.budget_max} onChange={(e) => set("budget_max", e.target.value)} />
      </label>
      <label className="qs-field span-2">
        <span>{t("wizard.details.description")}</span>
        <textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} />
      </label>
      <label className="qs-switch span-2">
        <input type="checkbox" checked={f.allow_wishlists} onChange={(e) => set("allow_wishlists", e.target.checked)} />
        <span>{t("wizard.details.wishlists")}</span>
      </label>
      <div className="span-2">
        <Button type="submit" className="qs-btn-primary">
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
