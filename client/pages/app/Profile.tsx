import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, ErrorNote, PageHeader, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { updateProfile } from "@/store/slices/authSlice";

/** Shared by /app/profile and /admin/profile. */
export default function Profile() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user)!;
  const [name, setName] = useState(user.full_name);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="portal-page">
      <PageHeader title={t("nav.profile")} subtitle={user.email} />
      <Card>
        <form
          className="qs-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const locale = i18n.language.startsWith("es") ? "es" : "en";
            const r = await dispatch(updateProfile({ full_name: name, locale }));
            if (updateProfile.fulfilled.match(r)) setOk(true);
            else setErr(r.payload ?? "errors.server");
          }}
        >
          <label className="qs-field">
            <span>{t("auth.yourName")}</span>
            <input value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setOk(false))} />
          </label>
          <label className="qs-field">
            <span>{t("common.language")}</span>
            <select value={i18n.language.startsWith("es") ? "es" : "en"} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <ErrorNote error={err} />
          <div className="qs-row">
            <Button type="submit" className="qs-btn-primary">
              {t("common.save")}
            </Button>
            {ok ? <span className="qs-fine">✓ {t("common.saved")}</span> : null}
          </div>
        </form>
      </Card>
      <Card title={t("profile.access")}>
        <ul className="qs-list">
          {user.platform_role ? (
            <li>
              <div>
                <strong>{t("shell.commandCenter")}</strong>
              </div>
              <StatusBadge value={user.platform_role} labelKey={`role.${user.platform_role}`} />
            </li>
          ) : null}
          {user.memberships.map((m) => (
            <li key={m.tenant_id}>
              <div>
                <strong>{m.tenant_name}</strong>
              </div>
              <StatusBadge value={m.role} labelKey={`role.${m.role}`} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
