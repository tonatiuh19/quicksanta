/**
 * Join with an exchange's shareable link or code.
 *  /join      → type a code (XXXX-XXXX, case/dash-insensitive)
 *  /j/:code   → public preview → sign in with email OTP → join instantly (organizer can remove before the draw)
 * Closed (after the draw), paused, expired and full links explain themselves; someone already in goes to their exchange.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, CalendarDays, Gift, KeyRound, Users, Wallet } from "lucide-react";
import type { JoinCodePreview } from "@shared/api";
import { Brand, ErrorNote, formatDate, Spinner } from "@/components/kit";
import OtpAuthCard from "@/components/OtpAuthCard";
import LanguageToggle from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe, logout } from "@/store/slices/authSlice";
import { fetchJoinCode, joinWithCode } from "@/store/slices/appSlice";
import { formatCodeInput, isCompleteCode } from "@/lib/joinCode";

export { formatCodeInput } from "@/lib/joinCode";

function CodeForm({ initial = "" }: { initial?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [code, setCode] = useState(formatCodeInput(initial));
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isCompleteCode(code)) return setErr("joinCode.errors.format");
    navigate(`/j/${code}`);
  };
  return (
    <form className="qs-form qs-code-form" onSubmit={submit} noValidate>
      <label className="qs-field">
        <span>{t("joinCode.codeLabel")}</span>
        <input
          className="qs-code-input"
          value={code}
          onChange={(e) => (setCode(formatCodeInput(e.target.value)), setErr(null))}
          placeholder="7K4P-QX9M"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          maxLength={9}
          autoFocus
        />
      </label>
      <ErrorNote error={err} />
      <Button type="submit" className="w-full qs-btn-primary">
        {t("joinCode.find")} <ArrowRight />
      </Button>
    </form>
  );
}

export default function JoinCode() {
  const { code = "" } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { user, bootstrapped } = useAppSelector((s) => s.auth);
  const [preview, setPreview] = useState<JoinCodePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsName = Boolean(user && (!user.full_name || user.full_name.includes("@")));
  const [name, setName] = useState("");

  useEffect(() => {
    if (!bootstrapped) void dispatch(fetchMe());
  }, [bootstrapped, dispatch]);

  useEffect(() => {
    if (!code) return;
    setPreview(null);
    setLoadError(null);
    dispatch(fetchJoinCode(code))
      .unwrap()
      .then(setPreview)
      .catch((e: string) => setLoadError(e));
  }, [code, user?.id, dispatch]);

  const join = async () => {
    if (needsName && !name.trim()) return setError("wizard.errors.organizerName");
    setBusy(true);
    setError(null);
    try {
      const r = await dispatch(joinWithCode({ code, name: needsName ? name.trim() : undefined })).unwrap();
      await dispatch(fetchMe());
      navigate(`/app/my/${r.event_public_id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <header className="qs-auth-top">
      <Link to="/">
        <Brand />
      </Link>
      <LanguageToggle />
    </header>
  );

  if (!code) {
    return (
      <div className="qs-auth-page">
        {header}
        <div className="qs-auth-card">
          <p className="qs-kicker">
            <KeyRound size={13} /> {t("joinCode.kicker")}
          </p>
          <h1>{t("joinCode.enterTitle")}</h1>
          <p className="qs-page-sub">{t("joinCode.enterSub")}</p>
          <CodeForm />
        </div>
      </div>
    );
  }

  return (
    <div className="qs-auth-page">
      {header}
      {!preview && !loadError ? <Spinner label={t("common.loading")} /> : null}
      {loadError ? (
        loadError === "errors.joinPaused" ? (
          // The organizer turned the link off: the server reveals nothing about the exchange.
          <div className="qs-auth-card">
            <h1>{t("joinCode.state.paused.title")}</h1>
            <p className="qs-page-sub">{t("joinCode.state.paused.body")}</p>
          </div>
        ) : (
          <div className="qs-auth-card">
            <h1>{t("joinCode.notFoundTitle")}</h1>
            <ErrorNote error={loadError} />
            <CodeForm initial={code} />
          </div>
        )
      ) : null}
      {preview ? (
        <div className="qs-invite">
          <div className="qs-invite-ticket">
            <span className="qs-kicker">{preview.tenant_name}</span>
            <h1>{preview.event_name}</h1>
            <p className="qs-invite-type">
              <Gift size={16} /> {preview.type_name}
            </p>
            <div className="qs-invite-meta">
              {preview.exchange_date ? (
                <span>
                  <CalendarDays size={15} /> {formatDate(preview.exchange_date, i18n.language)}
                </span>
              ) : null}
              {preview.budget ? (
                <span>
                  <Wallet size={15} /> {preview.budget}
                </span>
              ) : null}
              <span>
                <Users size={15} /> {t("drafts.people", { count: preview.people })}
              </span>
            </div>
            {preview.theme_rules ? <p className="qs-invite-rules">“{preview.theme_rules}”</p> : null}
            <p>{t("joinCode.invitedBy", { name: preview.organizer })}</p>
          </div>

          {preview.my_status === "joined" ? (
            <div className="qs-auth-card">
              <p>{t("join.already")}</p>
              <Link className="qs-btn qs-btn-primary" to={preview.event_public_id ? `/app/my/${preview.event_public_id}` : "/app/my"}>
                {t("join.goToMine")}
              </Link>
            </div>
          ) : preview.state !== "open" ? (
            <div className="qs-auth-card">
              <h2>{t(`joinCode.state.${preview.state}.title`)}</h2>
              <p className="qs-page-sub">{t(`joinCode.state.${preview.state}.body`, { name: preview.organizer })}</p>
            </div>
          ) : !user ? (
            <OtpAuthCard askName title={t("joinCode.signInTitle")} subtitle={t("joinCode.signInSub")} />
          ) : (
            <div className="qs-auth-card">
              <h2>{t("joinCode.readyTitle")}</h2>
              <p className="qs-page-sub">{t("joinCode.readySub", { email: user.email })}</p>
              {needsName ? (
                <label className="qs-field">
                  <span>{t("auth.yourName")}</span>
                  <input value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setError(null))} autoComplete="name" />
                </label>
              ) : null}
              <ErrorNote error={error} />
              <Button className="w-full qs-btn-primary" disabled={busy} onClick={() => void join()}>
                {busy ? t("joinCode.joining") : t("joinCode.join")} <ArrowRight />
              </Button>
              <button type="button" className="qs-link-btn" onClick={() => void dispatch(logout())}>
                {t("joinCode.notYou")}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
