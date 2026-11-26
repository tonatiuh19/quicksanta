/**
 * Plan & billing portal (organizers): plan hero + usage, payment method (update via Stripe Elements),
 * invoices, renewal/past-due/cancel-scheduled banners, and a respectful cancel flow tucked under
 * "Manage plan → More options": reason → one save offer → confirm by typing the workspace name.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, CalendarClock, Check, ChevronDown, CreditCard, Crown, Download, ExternalLink, Gift, HeartHandshake, RotateCcw, Sparkles, Users } from "lucide-react";
import { formatMoney, type CancelReason } from "@shared/api";
import { Card, ErrorNote, PageHeader, Spinner, StatusBadge, formatDate } from "@/components/kit";
import CheckoutCard from "@/components/billing/CheckoutCard";
import { Modal } from "@/components/portal/Modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { acceptSaveOffer, cancelSubscription, fetchBilling, resumeSubscription } from "@/store/slices/appSlice";
import { fetchMe } from "@/store/slices/authSlice";

const REASONS: CancelReason[] = ["too_expensive", "only_once", "missing_features", "too_complex", "switching", "other"];

export default function Billing() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const { billing: b, loading, error } = useAppSelector((s) => s.app);
  const user = useAppSelector((s) => s.auth.user)!;
  const workspace = user.memberships.find((m) => m.tenant_id === user.active_tenant_id);
  const [modal, setModal] = useState<null | "subscribe" | "card" | "cancel">(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const locale = i18n.language.startsWith("es") ? "es-MX" : "en-US";

  const reload = () => void dispatch(fetchBilling());
  useEffect(reload, [dispatch, user.active_tenant_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!b) return <div className="portal-page">{loading.billing ? <Spinner label={t("common.loading")} /> : <ErrorNote error={error} onRetry={reload} />}</div>;

  const price = formatMoney(b.pricing.pro_price_cents, b.pricing.pro_currency, locale);
  const isPro = b.plan === "pro";
  const hasSub = ["active", "trialing", "past_due"].includes(b.status);
  const renews = formatDate(b.current_period_end, i18n.language);
  const pct = Math.min(100, Math.round((b.usage.largest / Math.max(1, b.usage.limit)) * 100));

  const done = (key: string) => {
    setModal(null);
    setMoreOpen(false);
    setToast(t(key));
    reload();
    void dispatch(fetchMe());
  };

  return (
    <div className="portal-page qs-billing">
      <PageHeader kicker={workspace?.tenant_name} title={t("billing.title")} subtitle={t("billing.sub")} />
      {toast ? (
        <div className="qs-toast" role="status">
          <span>{toast}</span>
          <button className="qs-icon-btn" aria-label={t("common.close")} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      ) : null}
      <ErrorNote error={actionError} />

      {b.status === "past_due" ? (
        <div className="qs-pro-banner is-pending" role="alert">
          <AlertTriangle size={20} />
          <div>
            <strong>{t("billing.pastDueTitle")}</strong>
            <span>{t("billing.pastDueBody", { days: b.pricing.grace_days })}</span>
          </div>
          <Button className="qs-btn-primary" onClick={() => setModal("card")}>
            {t("billing.fixPayment")}
          </Button>
        </div>
      ) : null}
      {b.cancel_at_period_end && hasSub ? (
        <div className="qs-pro-banner">
          <CalendarClock size={20} />
          <div>
            <strong>{t("billing.endsTitle", { date: renews })}</strong>
            <span>{t("billing.endsBody")}</span>
          </div>
          <Button
            variant="outline"
            disabled={loading.busy}
            onClick={async () => {
              setActionError(null);
              const r = await dispatch(resumeSubscription());
              if (resumeSubscription.fulfilled.match(r)) done("billing.resumedToast");
              else setActionError(r.payload ?? "errors.server");
            }}
          >
            <RotateCcw /> {t("billing.resume")}
          </Button>
        </div>
      ) : null}

      <div className="qs-billing-grid">
        <section className={cn("qs-plan-hero", isPro && "is-pro", b.plan === "enterprise" && "is-enterprise")}>
          <div className="qs-plan-hero-top">
            <span className="qs-plan-hero-icon">{isPro || b.plan === "enterprise" ? <Crown size={22} /> : <Gift size={22} />}</span>
            <div>
              <p className="qs-kicker">{t("billing.currentPlan")}</p>
              <h2>
                {t(`landing.pricing.${b.plan}.name`)}{" "}
                {hasSub ? <StatusBadge value={b.status === "active" && b.cancel_at_period_end ? "canceling" : b.status} labelKey={`billing.status.${b.status === "active" && b.cancel_at_period_end ? "canceling" : b.status}`} /> : null}
              </h2>
            </div>
            {isPro ? (
              <p className="qs-plan-hero-price">
                <strong>{price}</strong>
                <span>/{t("billing.month")}</span>
              </p>
            ) : null}
          </div>
          {isPro && b.current_period_end ? (
            <p className="qs-plan-hero-line">
              <CalendarClock size={15} /> {b.cancel_at_period_end ? t("billing.endsOn", { date: renews }) : t("billing.renewsOn", { date: renews, price })}
            </p>
          ) : null}
          <div className="qs-usage">
            <div className="qs-usage-top">
              <span>
                <Users size={15} /> {t("billing.largest")}
              </span>
              <strong>
                {b.usage.largest}/{b.usage.limit}
              </strong>
            </div>
            <div className={cn("qs-meter", pct >= 90 && "is-hot")} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="qs-fine">{t("billing.usageLine", { events: b.usage.events })}</p>
          </div>
          {b.plan === "free" ? (
            <div className="qs-upgrade-box">
              <ul>
                {(t("landing.pricing.pro.features", { returnObjects: true }) as string[]).slice(1, 4).map((f) => (
                  <li key={f}>
                    <Check size={15} /> {f}
                  </li>
                ))}
              </ul>
              {b.usage.pending ? <p className="qs-fine qs-warn">{t("billing.pendingExchanges", { count: b.usage.pending })}</p> : null}
              <Button className="qs-btn-primary" onClick={() => setModal("subscribe")}>
                <Sparkles /> {t("billing.upgrade", { price })} <ArrowRight />
              </Button>
            </div>
          ) : null}
        </section>

        <Card title={t("billing.paymentMethod")} className="qs-pm-card">
          {b.card ? (
            <div className={cn("qs-mini-card", b.card.brand && `qs-cc--${b.card.brand === "mastercard" ? "mc" : b.card.brand}`)}>
              <span className="qs-cc-chip" />
              <strong>{(b.card.brand ?? "card").toUpperCase()}</strong>
              <span className="qs-mini-num">•••• {b.card.last4}</span>
              <span className="qs-mini-exp">{b.card.exp}</span>
            </div>
          ) : (
            <p className="qs-fine">{t("billing.noCard")}</p>
          )}
          {hasSub || b.card ? (
            <Button variant="outline" onClick={() => setModal("card")}>
              <CreditCard /> {t("billing.updateCard")}
            </Button>
          ) : null}
        </Card>
      </div>

      <Card title={t("billing.invoices")}>
        {b.invoices.length ? (
          <div className="table-scroll">
            <table className="qs-invoices">
              <thead>
                <tr>
                  <th>{t("billing.inv.date")}</th>
                  <th>{t("billing.inv.number")}</th>
                  <th>{t("billing.inv.amount")}</th>
                  <th>{t("billing.inv.status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{new Date(inv.created * 1000).toLocaleDateString(locale, { dateStyle: "medium" })}</td>
                    <td>{inv.number ?? "—"}</td>
                    <td>{formatMoney(inv.amount_cents, inv.currency, locale)}</td>
                    <td>
                      <StatusBadge value={inv.status === "paid" ? "succeeded" : inv.status === "open" ? "pending" : inv.status ?? "pending"} labelKey={`billing.inv.st.${inv.status ?? "open"}`} />
                    </td>
                    <td className="qs-inv-links">
                      {inv.hosted_invoice_url ? (
                        <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" aria-label={t("billing.inv.view")}>
                          <ExternalLink size={15} />
                        </a>
                      ) : null}
                      {inv.invoice_pdf ? (
                        <a href={inv.invoice_pdf} target="_blank" rel="noreferrer" aria-label={t("billing.inv.pdf")}>
                          <Download size={15} />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="qs-fine">{t("billing.noInvoices")}</p>
        )}
      </Card>

      {hasSub && !b.cancel_at_period_end ? (
        <section className="qs-manage">
          <button type="button" className="qs-manage-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            {t("billing.manage")} <ChevronDown size={16} />
          </button>
          {moreOpen ? (
            <div className="qs-manage-body">
              <p className="qs-fine">{t("billing.manageHint")}</p>
              <button type="button" className="qs-link-btn qs-cancel-link" onClick={() => setModal("cancel")}>
                {t("billing.cancelLink")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <Modal open={modal === "subscribe"} titleKey="billing.upgradeTitle" onClose={() => setModal(null)}>
        <div className="qs-modal-body">
          <CheckoutCard mode="subscribe" amountCents={b.pricing.pro_price_cents} currency={b.pricing.pro_currency} label={workspace?.tenant_name ?? ""} payerName={user.full_name} onDone={() => done("billing.subscribedToast")} />
        </div>
      </Modal>
      <Modal open={modal === "card"} titleKey="billing.updateCard" onClose={() => setModal(null)}>
        <div className="qs-modal-body">
          <CheckoutCard mode="update" amountCents={b.pricing.pro_price_cents} currency={b.pricing.pro_currency} label={workspace?.tenant_name ?? ""} payerName={user.full_name} onDone={() => done("billing.cardToast")} />
        </div>
      </Modal>
      {modal === "cancel" ? (
        <CancelFlow
          workspaceName={workspace?.tenant_name ?? ""}
          offerPercent={b.save_offer_available ? b.pricing.save_offer_percent : 0}
          price={price}
          endDate={renews}
          onClose={() => setModal(null)}
          onDone={(key) => done(key)}
        />
      ) : null}
    </div>
  );
}

function CancelFlow({ workspaceName, offerPercent, price, endDate, onClose, onDone }: { workspaceName: string; offerPercent: number; price: string; endDate: string; onClose: () => void; onDone: (toastKey: string) => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const busy = useAppSelector((s) => Boolean(s.app.loading.busy));
  const [step, setStep] = useState<"reason" | "offer" | "confirm">("reason");
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [feedback, setFeedback] = useState("");
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase().replace(/\s+/g, " ") === workspaceName.trim().toLowerCase().replace(/\s+/g, " ");
  const steps = offerPercent ? ["reason", "offer", "confirm"] : ["reason", "confirm"];

  return (
    <Modal open titleKey="billing.cancel.title" onClose={onClose}>
      <div className="qs-modal-body qs-cancel">
        <ol className="qs-cancel-steps" aria-hidden>
          {steps.map((s) => (
            <li key={s} className={s === step ? "is-current" : steps.indexOf(s) < steps.indexOf(step) ? "is-done" : ""} />
          ))}
        </ol>

        {step === "reason" ? (
          <>
            <h3>{t("billing.cancel.why")}</h3>
            <div className="qs-reasons" role="radiogroup" aria-label={t("billing.cancel.why")}>
              {REASONS.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={reason === r} className={cn("qs-reason", reason === r && "is-selected")} onClick={() => setReason(r)}>
                  {t(`billing.cancel.reasons.${r}`)}
                </button>
              ))}
            </div>
            <label className="qs-field">
              <span>{t("billing.cancel.feedback")}</span>
              <textarea rows={3} maxLength={1000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            </label>
            <div className="qs-modal-actions">
              <Button variant="ghost" onClick={onClose}>
                {t("billing.cancel.keep")}
              </Button>
              <Button variant="outline" onClick={() => setStep(offerPercent ? "offer" : "confirm")}>
                {t("common.next")}
              </Button>
            </div>
          </>
        ) : null}

        {step === "offer" ? (
          <>
            <div className="qs-offer">
              <span className="qs-offer-icon">
                <HeartHandshake size={28} />
              </span>
              <h3>{t("billing.cancel.offerTitle", { percent: offerPercent })}</h3>
              <p>{t("billing.cancel.offerBody", { percent: offerPercent, price })}</p>
            </div>
            <ErrorNote error={err} />
            <div className="qs-modal-actions">
              <Button variant="ghost" onClick={() => setStep("confirm")}>
                {t("billing.cancel.noThanks")}
              </Button>
              <Button
                className="qs-btn-primary"
                disabled={busy}
                onClick={async () => {
                  setErr(null);
                  const r = await dispatch(acceptSaveOffer());
                  if (acceptSaveOffer.fulfilled.match(r)) onDone("billing.offerToast");
                  else setErr(r.payload ?? "errors.server");
                }}
              >
                <Sparkles /> {t("billing.cancel.acceptOffer", { percent: offerPercent })}
              </Button>
            </div>
          </>
        ) : null}

        {step === "confirm" ? (
          <>
            <h3>{t("billing.cancel.confirmTitle")}</h3>
            <ul className="qs-lose">
              <li>{t("billing.cancel.lose1", { date: endDate })}</li>
              <li>{t("billing.cancel.lose2")}</li>
              <li>{t("billing.cancel.lose3")}</li>
            </ul>
            <label className="qs-field">
              <span>{t("billing.cancel.typeName", { name: workspaceName })}</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={workspaceName} autoComplete="off" aria-label={t("billing.cancel.typeLabel")} />
            </label>
            <ErrorNote error={err} />
            <div className="qs-modal-actions">
              <Button className="qs-btn-primary" onClick={onClose}>
                {t("billing.cancel.keep")}
              </Button>
              <Button
                variant="ghost"
                className="qs-danger-ghost"
                disabled={!matches || busy}
                onClick={async () => {
                  setErr(null);
                  const r = await dispatch(cancelSubscription({ reason: reason ?? "other", feedback, confirm_name: typed }));
                  if (cancelSubscription.fulfilled.match(r)) onDone("billing.cancelledToast");
                  else setErr(r.payload ?? "errors.server");
                }}
              >
                {t("billing.cancel.confirm")}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
