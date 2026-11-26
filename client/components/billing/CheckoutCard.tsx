/**
 * Secure card form (Stripe split Elements, ported from groundwork's SecureCardForm) beside a live 3D card
 * that mirrors what you type: brand colors, flip on CVC, gold glow when complete.
 *
 * Modes:
 * - "subscribe": starts the Pro subscription ($8.90/month), pays its first invoice, then syncs the workspace.
 * - "update":    saves a new card for renewals (SetupIntent) and retries a failed renewal.
 * Card data goes straight to Stripe; our API only creates/syncs (appSlice thunks).
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadStripe, type StripeElementStyle } from "@stripe/stripe-js";
import { CardCvcElement, CardExpiryElement, CardNumberElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { CalendarClock, CheckCircle2, CreditCard, KeyRound, Loader2, Lock, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { formatMoney } from "@shared/api";
import { ErrorNote } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppDispatch } from "@/store/hooks";
import { saveCard, startCardUpdate, startSubscription, syncSubscription } from "@/store/slices/appSlice";

const PUBLISHABLE_KEY = String(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");
let stripePromise: ReturnType<typeof loadStripe> | null = null;
const getStripe = () => (stripePromise ??= PUBLISHABLE_KEY ? loadStripe(PUBLISHABLE_KEY) : Promise.resolve(null));

/** Fields render in Stripe iframes: concrete colors only (CSS vars don't cross the frame). */
const FIELD_STYLE: StripeElementStyle = {
  base: { color: "#1f1a17", fontFamily: "Manrope, system-ui, sans-serif", fontSize: "16px", fontWeight: "600", letterSpacing: "0.02em", "::placeholder": { color: "#a8a29e" }, iconColor: "#b91c1c" },
  invalid: { color: "#b91c1c", iconColor: "#b91c1c" },
  complete: { iconColor: "#166534" },
};

const BRAND: Record<string, { label: string; tone: string }> = {
  visa: { label: "VISA", tone: "visa" },
  mastercard: { label: "Mastercard", tone: "mc" },
  amex: { label: "AMEX", tone: "amex" },
  discover: { label: "Discover", tone: "disc" },
  diners: { label: "Diners", tone: "disc" },
  jcb: { label: "JCB", tone: "disc" },
  unionpay: { label: "UnionPay", tone: "disc" },
};

type FieldKey = "number" | "expiry" | "cvc";

export type CheckoutProps = {
  mode?: "subscribe" | "update";
  amountCents: number;
  currency: string;
  /** e.g. the workspace name, shown in the lead line */
  label: string;
  payerName?: string;
  onDone: () => void;
};

function CardForm({ mode = "subscribe", amountCents, currency, label, payerName, onDone }: CheckoutProps) {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const stripe = useStripe();
  const elements = useElements();
  const [brand, setBrand] = useState("unknown");
  const [done, setDone] = useState<Record<FieldKey, boolean>>({ number: false, expiry: false, cvc: false });
  const [focus, setFocus] = useState<FieldKey | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "paying" | "done">("idle");
  const ready = Boolean(stripe && elements) && done.number && done.expiry && done.cvc;
  const price = formatMoney(amountCents, currency, i18n.language.startsWith("es") ? "es-MX" : "en-US");
  const isUpdate = mode === "update";

  const track = (key: FieldKey) => ({
    options: { style: FIELD_STYLE, ...(key === "number" ? { showIcon: true, iconStyle: "solid" as const, disableLink: true } : {}) },
    onFocus: () => setFocus(key),
    onBlur: () => setFocus(null),
    onChange: (e: { complete: boolean; error?: { message: string }; brand?: string }) => {
      setDone((d) => ({ ...d, [key]: e.complete }));
      setFieldError(e.error?.message ?? null);
      if (key === "number" && e.brand) setBrand(e.brand);
    },
  });

  const submit = async () => {
    if (!stripe || !elements) return;
    const card = elements.getElement(CardNumberElement);
    if (!card) return;
    setError(null);
    setPhase("paying");
    try {
      const billing_details = { name: payerName || undefined };
      if (isUpdate) {
        const { client_secret } = await dispatch(startCardUpdate()).unwrap();
        const r = await stripe.confirmCardSetup(client_secret, { payment_method: { card, billing_details } });
        if (r.error || !r.setupIntent?.payment_method) throw new Error(r.error?.message || "errors.cardNotSaved");
        const pm = typeof r.setupIntent.payment_method === "string" ? r.setupIntent.payment_method : r.setupIntent.payment_method.id;
        const saved = await dispatch(saveCard(pm)).unwrap();
        if (saved.retried && saved.retried !== "paid") throw new Error("errors.retryFailed");
      } else {
        const { client_secret } = await dispatch(startSubscription()).unwrap();
        // confirmCardPayment also runs 3-D Secure in Stripe's modal when the bank asks for it.
        const r = await stripe.confirmCardPayment(client_secret, { payment_method: { card, billing_details } });
        const status = r.paymentIntent?.status;
        if (r.error || (status !== "succeeded" && status !== "processing")) throw new Error(r.error?.message || "errors.paymentNotCompleted");
        // Money is taken (or processing): never show an error now. If the sync call fails, the webhook finishes it.
        await dispatch(syncSubscription())
          .unwrap()
          .catch(() => undefined);
      }
      setPhase("done");
      setTimeout(onDone, 1300);
    } catch (e) {
      setPhase("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const b = BRAND[brand];
  return (
    <div className={cn("qs-checkout", phase === "done" && "is-paid")}>
      <div className={cn("qs-cc", focus === "cvc" && "is-flipped", ready && "is-ready", b && `qs-cc--${b.tone}`)} aria-hidden>
        <div className="qs-cc-inner">
          <div className="qs-cc-front">
            <div className="qs-cc-top">
              <span className="qs-cc-chip" />
              <span className="qs-cc-brand">{b ? b.label : <CreditCard size={22} />}</span>
            </div>
            <div className={cn("qs-cc-number", done.number && "is-done")}>{done.number ? "•••• •••• •••• ••••" : "1234 5678 9012 3456"}</div>
            <div className="qs-cc-bottom">
              <span>
                <small>{t("checkout.cardHolder")}</small>
                {payerName || "QuickSanta"}
              </span>
              <span>
                <small>{t("checkout.expiry")}</small>
                {done.expiry ? "••/••" : "MM/YY"}
              </span>
            </div>
            <span className="qs-cc-shine" />
          </div>
          <div className="qs-cc-back">
            <span className="qs-cc-stripe" />
            <span className="qs-cc-cvc">{done.cvc ? "•••" : "CVC"}</span>
          </div>
        </div>
      </div>

      <div className="qs-checkout-form">
        <div className="qs-checkout-head">
          <span className="qs-checkout-lock" aria-hidden>
            {isUpdate ? <RefreshCw size={16} /> : <Lock size={16} />}
          </span>
          <div>
            <strong>{isUpdate ? t("billing.updateTitle") : t("checkout.subTitle", { price })}</strong>
            <span>{isUpdate ? t("billing.updateLead") : t("checkout.subLead", { name: label })}</span>
          </div>
        </div>

        <label className={cn("qs-card-field", focus === "number" && "is-focus", done.number && "is-done")}>
          <span className="qs-card-field__label">
            <CreditCard size={14} aria-hidden /> {t("checkout.cardNumber")}
          </span>
          <CardNumberElement {...track("number")} className="qs-card-field__input" />
        </label>
        <div className="qs-checkout-row">
          <label className={cn("qs-card-field", focus === "expiry" && "is-focus", done.expiry && "is-done")}>
            <span className="qs-card-field__label">
              <CalendarClock size={14} aria-hidden /> {t("checkout.expiry")}
            </span>
            <CardExpiryElement {...track("expiry")} className="qs-card-field__input" />
          </label>
          <label className={cn("qs-card-field", focus === "cvc" && "is-focus", done.cvc && "is-done")}>
            <span className="qs-card-field__label">
              <KeyRound size={14} aria-hidden /> {t("checkout.cvc")}
            </span>
            <CardCvcElement {...track("cvc")} className="qs-card-field__input" />
          </label>
        </div>
        {fieldError ? (
          <p className="qs-fine qs-warn" role="alert">
            {fieldError}
          </p>
        ) : null}
        <ErrorNote error={error} />

        <Button className="qs-btn-primary qs-pay-btn" disabled={!ready || phase !== "idle"} onClick={() => void submit()}>
          {phase === "paying" ? <Loader2 className="spin" /> : phase === "done" ? <CheckCircle2 /> : <ShieldCheck />}
          {phase === "paying" ? t("checkout.paying") : phase === "done" ? t(isUpdate ? "billing.cardSaved" : "checkout.paid") : isUpdate ? t("billing.saveCard") : t("checkout.subscribe", { price })}
        </Button>
        {!isUpdate ? <p className="qs-fine center">{t("checkout.subFine")}</p> : null}
        <ul className="qs-checkout-trust">
          <li>
            <Lock size={13} aria-hidden /> {t("checkout.trustEncrypted")}
          </li>
          <li>
            <ShieldCheck size={13} aria-hidden /> {t("checkout.trustNeverStored")}
          </li>
        </ul>
      </div>

      {phase === "done" ? (
        <div className="qs-checkout-success" role="status">
          <span>
            <Sparkles size={30} />
          </span>
          <strong>{t(isUpdate ? "billing.cardSavedTitle" : "checkout.successTitle")}</strong>
        </div>
      ) : null}
    </div>
  );
}

export default function CheckoutCard(props: CheckoutProps) {
  const { t, i18n } = useTranslation();
  const stripe = useMemo(() => getStripe(), []);
  if (!PUBLISHABLE_KEY) return <div className="qs-error">{t("errors.paymentsUnavailable")}</div>;
  return (
    <Elements
      stripe={stripe}
      options={{ locale: i18n.language?.startsWith("es") ? "es" : "en", fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700&display=swap" }] }}
    >
      <CardForm {...props} />
    </Elements>
  );
}
