import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarDays, Gift, Wallet } from "lucide-react";
import { Brand, ErrorNote, formatDate, Spinner } from "@/components/kit";
import OtpAuthCard from "@/components/OtpAuthCard";
import LanguageToggle from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe, logout } from "@/store/slices/authSlice";
import { fetchInvite, respondInvite, type InvitePreview } from "@/store/slices/appSlice";

type Invite = InvitePreview;

/** Invitation landing. The invite preview is public; accepting requires signing in with the invited email. */
export default function Join() {
  const { token = "" } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { user, bootstrapped } = useAppSelector((s) => s.auth);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bootstrapped) void dispatch(fetchMe());
  }, [bootstrapped, dispatch]);

  useEffect(() => {
    // Token-scoped preview: result kept in local state (nothing else reads it).
    dispatch(fetchInvite(token))
      .unwrap()
      .then(setInvite)
      .catch((e: string) => setError(e));
  }, [token, dispatch]);

  const respond = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await dispatch(respondInvite({ token, accept })).unwrap();
      await dispatch(fetchMe());
      if (accept) navigate(`/app/my/${r.event_public_id}`);
      else setInvite((i) => (i ? { ...i, status: "declined" } : i));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qs-auth-page">
      <header className="qs-auth-top">
        <Link to="/">
          <Brand />
        </Link>
        <LanguageToggle />
      </header>
      {!invite && !error ? <Spinner label={t("common.loading")} /> : null}
      {!invite && error ? (
        <div className="qs-auth-card">
          <ErrorNote error={error} />
        </div>
      ) : null}
      {invite ? (
        <div className="qs-invite">
          <div className="qs-invite-ticket">
            <span className="qs-kicker">{invite.tenant_name}</span>
            <h1>{invite.event_name}</h1>
            <p className="qs-invite-type">
              <Gift size={16} /> {invite.type_name}
            </p>
            <div className="qs-invite-meta">
              {invite.exchange_date ? (
                <span>
                  <CalendarDays size={15} /> {formatDate(invite.exchange_date, i18n.language)}
                </span>
              ) : null}
              {invite.budget ? (
                <span>
                  <Wallet size={15} /> {invite.budget}
                </span>
              ) : null}
            </div>
            {invite.theme_rules ? <p className="qs-invite-rules">“{invite.theme_rules}”</p> : null}
            <p>{t("join.hello", { name: invite.name })}</p>
          </div>
          {!user ? (
            <OtpAuthCard title={t("join.signInTitle")} subtitle={t("join.signInSub", { email: invite.email_hint })} />
          ) : invite.status === "joined" ? (
            <div className="qs-auth-card">
              <p>{t("join.already")}</p>
              <Link className="qs-btn qs-btn-primary" to="/app/my">
                {t("join.goToMine")}
              </Link>
            </div>
          ) : (
            <div className="qs-auth-card">
              <ErrorNote error={error} opts={{ expected: invite.email_hint }} />
              {error === "errors.inviteWrongAccount" ? (
                <button className="qs-link-btn" onClick={() => void dispatch(logout())}>
                  {t("join.switchAccount")}
                </button>
              ) : null}
              <div className="qs-row">
                <Button className="qs-btn-primary" disabled={busy} onClick={() => void respond(true)}>
                  {t("join.accept")}
                </Button>
                <Button variant="outline" disabled={busy || invite.status === "declined"} onClick={() => void respond(false)}>
                  {invite.status === "declined" ? t("status.declined") : t("join.decline")}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
