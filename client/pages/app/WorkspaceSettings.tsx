import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, ErrorNote, PageHeader } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { updateTenant } from "@/store/slices/appSlice";
import { fetchMe } from "@/store/slices/authSlice";

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user)!;
  const active = user.memberships.find((m) => m.tenant_id === user.active_tenant_id);
  const [name, setName] = useState(active?.tenant_name ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="portal-page">
      <PageHeader title={t("nav.workspaceSettings")} />
      <Card>
        <form
          className="qs-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await dispatch(updateTenant({ name })).unwrap();
              await dispatch(fetchMe());
              setOk(true);
            } catch (x) {
              setErr(String(x));
            }
          }}
        >
          <label className="qs-field">
            <span>{t("settings.workspaceName")}</span>
            <input value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setOk(false))} />
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
    </div>
  );
}
