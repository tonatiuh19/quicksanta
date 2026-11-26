/** Passwordless sign-in: email → 6-digit code. Used by /login, the wizard and /join. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Mail } from "lucide-react";
import OtpCodeInput from "@/components/portal/OtpCodeInput";
import { ErrorNote } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { backToEmail, requestOtp, verifyOtp } from "@/store/slices/authSlice";
import { EMAIL_RE, normalizeEmail } from "@shared/api";

export default function OtpAuthCard({ defaultEmail = "", askName = false, onSignedIn, title, subtitle }: { defaultEmail?: string; askName?: boolean; onSignedIn?: () => void; title?: string; subtitle?: string }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { step, email, busy, error, isNew } = useAppSelector((s) => s.auth);
  const [emailDraft, setEmailDraft] = useState(defaultEmail);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const submitEmail = async (e?: FormEvent) => {
    e?.preventDefault();
    const v = normalizeEmail(emailDraft);
    if (!EMAIL_RE.test(v)) return setLocalError("validation.email");
    setLocalError(null);
    setCode("");
    const r = await dispatch(requestOtp(v));
    if (requestOtp.fulfilled.match(r)) setCooldown(30);
  };

  const submitCode = useCallback(
    async (c: string) => {
      const r = await dispatch(verifyOtp({ email, code: c, full_name: name.trim() || undefined }));
      if (verifyOtp.fulfilled.match(r)) onSignedIn?.();
      else setCode("");
    },
    [dispatch, email, name, onSignedIn],
  );

  return (
    <div className="qs-auth-card">
      <h1>{title ?? t("auth.title")}</h1>
      <p className="qs-page-sub">{subtitle ?? t("auth.subtitle")}</p>
      {step === "email" ? (
        <form onSubmit={submitEmail} className="qs-form" noValidate>
          <label className="qs-field">
            <span>{t("auth.email")}</span>
            <input type="email" autoComplete="email" inputMode="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} placeholder={t("auth.emailPh")} autoFocus />
          </label>
          <ErrorNote error={localError ?? error} />
          <Button type="submit" disabled={busy} className="w-full qs-btn-primary">
            <Mail /> {busy ? t("auth.sending") : t("auth.sendCode")}
          </Button>
          <p className="qs-fine">{t("auth.noPassword")}</p>
          <p className="qs-fine qs-consent">
            {t("legal.consentPrefix")} <Link to="/terms">{t("legal.terms")}</Link> {t("legal.and")} <Link to="/privacy">{t("legal.privacy")}</Link>.
          </p>
        </form>
      ) : (
        <div className="qs-form">
          <p className="qs-sent-to">{t("auth.sentTo", { email })}</p>
          {askName ? (
            <label className="qs-field">
              <span>{t("auth.yourName")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          ) : null}
          <OtpCodeInput value={code} onChange={setCode} onComplete={submitCode} verifying={busy} label={t("auth.code")} />
          <ErrorNote error={error} />
          <div className="qs-auth-actions">
            <button type="button" className="qs-link-btn" onClick={() => dispatch(backToEmail())}>
              <ArrowLeft size={14} /> {t("auth.changeEmail")}
            </button>
            <button type="button" className="qs-link-btn" disabled={cooldown > 0 || busy} onClick={() => void dispatch(requestOtp(email)).then(() => setCooldown(30))}>
              {cooldown > 0 ? t("auth.resendIn", { s: cooldown }) : t("auth.resend")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
