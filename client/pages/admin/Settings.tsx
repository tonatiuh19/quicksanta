import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { platformCan } from "@shared/api";
import { Card, ErrorNote, PageHeader } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchSettings, saveSettings } from "@/store/slices/adminSlice";

const FIELDS: Array<{ key: string; type: "number" | "bool" }> = [
  { key: "signups_enabled", type: "bool" },
  { key: "session_days", type: "number" },
  { key: "default_max_events", type: "number" },
  { key: "free_max_participants", type: "number" },
  { key: "pro_max_participants", type: "number" },
  { key: "pro_price_cents", type: "number" },
  { key: "subscription_grace_days", type: "number" },
  { key: "save_offer_percent", type: "number" },
];

export default function AdminSettings() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const me = useAppSelector((s) => s.auth.user)!;
  const { settings, error } = useAppSelector((s) => s.admin);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ok, setOk] = useState(false);
  const canWrite = platformCan(me.platform_role, "settings.write");
  useEffect(() => {
    void dispatch(fetchSettings());
  }, [dispatch]);
  useEffect(() => setValues(Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value ?? ""]))), [settings]);
  const version = settings.find((s) => s.setting_key === "app_version")?.setting_value;
  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.settings")} subtitle={version ? t("admin.settings.version", { v: version }) : undefined} />
      <Card>
        <form
          className="qs-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(FIELDS.map((f) => [f.key, values[f.key] ?? ""]));
            const r = await dispatch(saveSettings(payload));
            setOk(saveSettings.fulfilled.match(r));
          }}
        >
          {FIELDS.map((f) =>
            f.type === "bool" ? (
              <label key={f.key} className="qs-switch">
                <input type="checkbox" disabled={!canWrite} checked={values[f.key] === "1"} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked ? "1" : "0" })} />
                <span>{t(`admin.settings.${f.key}`)}</span>
              </label>
            ) : (
              <label key={f.key} className="qs-field">
                <span>{t(`admin.settings.${f.key}`)}</span>
                <input type="number" min={1} disabled={!canWrite} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              </label>
            ),
          )}
          <ErrorNote error={error} />
          {canWrite ? (
            <div className="qs-row">
              <Button type="submit" className="qs-btn-primary">
                {t("common.save")}
              </Button>
              {ok ? <span className="qs-fine">✓ {t("common.saved")}</span> : null}
            </div>
          ) : (
            <p className="qs-fine">{t("admin.settings.ownerOnly")}</p>
          )}
        </form>
      </Card>
    </div>
  );
}
