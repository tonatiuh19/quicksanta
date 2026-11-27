/**
 * Command Center → Email gallery: every email QuickSanta sends, rendered with sample data.
 * Toggle EN/ES, desktop/phone width, light/dark, HTML/plain text; "Send a test to me" goes to your own inbox only.
 * The HTML is shown in a sandboxed iframe (no scripts, no same-origin).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Send, Smartphone, Sun } from "lucide-react";
import { ErrorNote, PageHeader, Spinner } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchEmailPreview, fetchEmailPreviews, sendTestEmail } from "@/store/slices/adminSlice";

type Lang = "en" | "es";

/** Force the template's dark-mode rules on (iframes follow the OS, not a toggle). */
export const forceDark = (html: string) => html.replace("@media (prefers-color-scheme: dark){", "@media all{");

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ v: T; label: string; icon?: JSX.Element }>; onChange: (v: T) => void }) {
  return (
    <div className="qs-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? "is-on" : ""} onClick={() => onChange(o.v)}>
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

export default function EmailGallery() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { emailPreviews, emailPreview, loading, error } = useAppSelector((s) => s.admin);
  const [key, setKey] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [view, setView] = useState<"html" | "text">("html");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void dispatch(fetchEmailPreviews());
  }, [dispatch]);
  useEffect(() => {
    if (!key && emailPreviews.length) setKey(emailPreviews[0].key);
  }, [emailPreviews, key]);
  useEffect(() => {
    if (key) void dispatch(fetchEmailPreview({ key, lang }));
  }, [key, lang, dispatch]);

  const current = emailPreview && emailPreview.key === key && emailPreview.lang === lang ? emailPreview : null;
  const name = (k: string) => t(`admin.gallery.names.${k}`, { defaultValue: k });

  const sendTest = async () => {
    if (!key) return;
    setToast(null);
    try {
      const r = await dispatch(sendTestEmail({ key, lang })).unwrap();
      setToast(String(t(r.dry_run ? "admin.gallery.sentDry" : "admin.gallery.sent", { email: r.to })));
    } catch {
      /* shown by ErrorNote */
    }
  };

  return (
    <div className="portal-page">
      <PageHeader kicker={t("shell.commandCenter")} title={t("admin.nav.emailGallery")} subtitle={t("admin.gallery.sub")} />
      <ErrorNote error={error} />
      <div className="qs-gallery">
        <nav className="qs-gallery-list" aria-label={t("admin.gallery.templates")}>
          <label className="qs-field qs-gallery-select">
            <span>{t("admin.gallery.templates")}</span>
            <select value={key ?? ""} onChange={(e) => setKey(e.target.value)}>
              {emailPreviews.map((p) => (
                <option key={p.key} value={p.key}>
                  {name(p.key)}
                </option>
              ))}
            </select>
          </label>
          <ul>
            {emailPreviews.map((p) => (
              <li key={p.key}>
                <button type="button" aria-current={key === p.key ? "true" : undefined} className={key === p.key ? "is-on" : ""} onClick={() => setKey(p.key)}>
                  <strong>{name(p.key)}</strong>
                  <span>{p.subject}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="qs-gallery-main" aria-live="polite">
          <div className="qs-gallery-toolbar">
            <Seg<Lang> label={t("admin.gallery.language")} value={lang} onChange={setLang} options={[{ v: "en", label: "EN" }, { v: "es", label: "ES" }]} />
            <Seg<"desktop" | "phone"> label={t("admin.gallery.width")} value={width} onChange={setWidth} options={[{ v: "desktop", label: t("admin.gallery.desktop"), icon: <Monitor size={14} /> }, { v: "phone", label: t("admin.gallery.phone"), icon: <Smartphone size={14} /> }]} />
            <Seg<"light" | "dark"> label={t("admin.gallery.theme")} value={theme} onChange={setTheme} options={[{ v: "light", label: t("admin.gallery.light"), icon: <Sun size={14} /> }, { v: "dark", label: t("admin.gallery.dark"), icon: <Moon size={14} /> }]} />
            <Seg<"html" | "text"> label={t("admin.gallery.format")} value={view} onChange={setView} options={[{ v: "html", label: "HTML" }, { v: "text", label: t("admin.gallery.text") }]} />
            <Button className="qs-btn-primary" disabled={!key || loading.sendTest} onClick={() => void sendTest()}>
              <Send /> {t("admin.gallery.sendTest")}
            </Button>
          </div>
          {toast ? (
            <p className="qs-fine qs-gallery-toast" role="status">
              {toast}
            </p>
          ) : null}
          {current ? (
            <>
              <p className="qs-gallery-subject">
                <span>{t("admin.gallery.subject")}</span> <strong>{current.subject}</strong>
              </p>
              {view === "html" ? (
                <div className={`qs-gallery-frame is-${width}`}>
                  <iframe title={t("admin.gallery.previewOf", { name: name(current.key) })} sandbox="" srcDoc={theme === "dark" ? forceDark(current.html) : current.html} />
                </div>
              ) : (
                <pre className="qs-gallery-text">{current.text}</pre>
              )}
            </>
          ) : (
            <Spinner label={t("common.loading")} />
          )}
        </section>
      </div>
    </div>
  );
}
