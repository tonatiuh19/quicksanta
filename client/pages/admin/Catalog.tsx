import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Card, ErrorNote, PageHeader, StatusBadge } from "@/components/kit";
import { Modal } from "@/components/portal/Modal";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchAdminCatalog, saveEventType, type AdminEventType } from "@/store/slices/adminSlice";
import { fetchEventTypes } from "@/store/slices/catalogSlice";

const blank = { slug: "", name_en: "", name_es: "", description_en: "", description_es: "", icon: "gift", uses_draw: true, is_active: true, sort_order: 100 };

export default function Catalog() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const { catalog, error } = useAppSelector((s) => s.admin);
  const [editing, setEditing] = useState<(typeof blank & { id?: number }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const es = i18n.language.startsWith("es");
  useEffect(() => {
    void dispatch(fetchAdminCatalog());
  }, [dispatch]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, ...data } = editing;
    const r = await dispatch(saveEventType({ id, data: id ? (({ slug: _s, ...rest }) => rest)(data) : data }));
    if (saveEventType.fulfilled.match(r)) {
      setEditing(null);
      void dispatch(fetchAdminCatalog());
      void dispatch(fetchEventTypes());
    } else setErr(r.payload ?? "errors.server");
  };
  const set = (k: string, v: unknown) => setEditing((x) => (x ? { ...x, [k]: v } : x));

  return (
    <div className="portal-page">
      <PageHeader
        kicker={t("shell.commandCenter")}
        title={t("admin.nav.catalog")}
        subtitle={t("admin.catalog.sub")}
        actions={
          <Button className="qs-btn-primary" onClick={() => (setErr(null), setEditing({ ...blank }))}>
            <Plus /> {t("admin.catalog.new")}
          </Button>
        }
      />
      <ErrorNote error={error} />
      <div className="qs-card-grid">
        {catalog.map((c: AdminEventType) => (
          <Card key={c.id} className="qs-catalog-card">
            <div className="qs-mobile-card-top">
              <strong>{es ? c.name_es : c.name_en}</strong>
              <StatusBadge value={c.is_active ? "active" : "archived"} />
            </div>
            <p className="qs-fine">{es ? c.description_es : c.description_en}</p>
            <p className="qs-fine">
              <code>{c.slug}</code> · {c.uses_draw ? t("admin.catalog.draw") : t("admin.catalog.noDraw")} · {t("admin.catalog.usage", { n: c.usage_count })}
            </p>
            <Button variant="outline" size="sm" onClick={() => (setErr(null), setEditing({ ...c }))}>
              {t("common.edit")}
            </Button>
          </Card>
        ))}
      </div>
      <Modal open={editing !== null} titleKey={editing?.id ? "common.edit" : "admin.catalog.new"} onClose={() => setEditing(null)}>
        {editing ? (
          <form className="qs-form qs-form-grid qs-modal-body" onSubmit={submit}>
            <label className="qs-field">
              <span>Slug</span>
              <input required pattern="[a-z0-9_]{2,40}" disabled={Boolean(editing.id)} value={editing.slug} onChange={(e) => set("slug", e.target.value)} />
            </label>
            <label className="qs-field">
              <span>{t("admin.catalog.icon")}</span>
              <select value={editing.icon} onChange={(e) => set("icon", e.target.value)}>
                {["gift", "party", "list", "book", "cookie"].map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </label>
            <label className="qs-field">
              <span>Name (EN)</span>
              <input required value={editing.name_en} onChange={(e) => set("name_en", e.target.value)} />
            </label>
            <label className="qs-field">
              <span>Nombre (ES)</span>
              <input required value={editing.name_es} onChange={(e) => set("name_es", e.target.value)} />
            </label>
            <label className="qs-field span-2">
              <span>Description (EN)</span>
              <input value={editing.description_en} onChange={(e) => set("description_en", e.target.value)} />
            </label>
            <label className="qs-field span-2">
              <span>Descripción (ES)</span>
              <input value={editing.description_es} onChange={(e) => set("description_es", e.target.value)} />
            </label>
            <label className="qs-switch">
              <input type="checkbox" checked={editing.uses_draw} onChange={(e) => set("uses_draw", e.target.checked)} />
              <span>{t("admin.catalog.draw")}</span>
            </label>
            <label className="qs-switch">
              <input type="checkbox" checked={editing.is_active} onChange={(e) => set("is_active", e.target.checked)} />
              <span>{t("status.active")}</span>
            </label>
            <label className="qs-field">
              <span>{t("admin.catalog.order")}</span>
              <input type="number" value={editing.sort_order} onChange={(e) => set("sort_order", Number(e.target.value))} />
            </label>
            <div className="span-2">
              <ErrorNote error={err} />
            </div>
            <div className="qs-modal-actions span-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" className="qs-btn-primary">
                {t("common.save")}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
