import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import OtpAuthCard from "@/components/OtpAuthCard";
import { Brand } from "@/components/kit";
import LanguageToggle from "@/components/LanguageToggle";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe } from "@/store/slices/authSlice";

export function homeFor(user: { platform_role: string | null; memberships: unknown[] }) {
  if (user.platform_role && user.memberships.length === 0) return "/admin";
  return user.memberships.length ? "/app" : "/start";
}

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [params] = useSearchParams();
  const { user, bootstrapped } = useAppSelector((s) => s.auth);
  const next = params.get("next");

  useEffect(() => {
    if (!bootstrapped) void dispatch(fetchMe());
  }, [bootstrapped, dispatch]);

  useEffect(() => {
    if (user) navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : homeFor(user), { replace: true });
  }, [user, next, navigate]);

  return (
    <div className="qs-auth-page">
      <header className="qs-auth-top">
        <Link to="/">
          <Brand />
        </Link>
        <LanguageToggle />
      </header>
      <OtpAuthCard askName />
      <p className="qs-fine center">
        {t("auth.newHere")} <Link to="/start">{t("auth.startWizard")}</Link>
        <br />
        {t("auth.haveCode")} <Link to="/join">{t("auth.joinWithCode")}</Link>
      </p>
    </div>
  );
}
