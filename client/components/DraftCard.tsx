/**
 * "Continue your draft" ticket: the one active wizard draft (browser or account) with service, name,
 * people, a progress ring and the last edit. Used on the dashboard and on the /start resume screen.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Clock, Sparkles, Trash2, Users } from "lucide-react";
import { useAppSelector } from "@/store/hooks";
import { DRAFT_TTL_DAYS, draftHasContent, wizardPeople, wizardSteps, clampStep } from "@/store/slices/wizardSlice";
import { CUSTOM_ICON_MAP, SERVICE_ICON_MAP, gradientFor } from "@/components/customDesign";

export function relativeTime(iso: string, lang: string, now = Date.now()): string {
  const diff = Math.min(0, (Date.parse(iso) - now) / 1000); // a clock ahead of ours still reads "now"
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function ProgressRing({ value, label }: { value: number; label: string }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="qs-ring" role="img" aria-label={label}>
      <svg viewBox="0 0 56 56" width="56" height="56" aria-hidden>
        <circle cx="28" cy="28" r={r} className="qs-ring-track" />
        <circle cx="28" cy="28" r={r} className="qs-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <span>{Math.round(pct * 100)}%</span>
    </div>
  );
}

export default function DraftCard({ onContinue, onDiscard, discardLabel, extra }: { onContinue: () => void; onDiscard: () => void; discardLabel?: string; extra?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { draft: d, step, savedAt } = useAppSelector((s) => s.wizard);
  const user = useAppSelector((s) => s.auth.user);
  const catalog = useAppSelector((s) => s.catalog.items);
  const [confirm, setConfirm] = useState(false);
  if (!draftHasContent(d, step)) return null;
  const es = i18n.language?.startsWith("es");
  const type = catalog.find((x) => x.slug === d.eventTypeSlug);
  const isCustom = d.eventTypeSlug === "custom";
  const steps = wizardSteps(d, type, Boolean(user));
  const at = clampStep(step, steps);
  const done = steps.indexOf(at) / steps.length;
  const Icon = isCustom ? CUSTOM_ICON_MAP[d.custom?.icon ?? "sparkles"] ?? Sparkles : SERVICE_ICON_MAP[type?.icon ?? ""] ?? Sparkles;
  const kind = isCustom ? d.custom?.name || t("drafts.customKind") : type ? (es ? type.name_es : type.name_en) : "";
  const people = wizardPeople(d, user?.email).length;
  const expiresIn = savedAt ? Math.max(1, Math.ceil((Date.parse(savedAt) + DRAFT_TTL_DAYS * 86_400_000 - Date.now()) / 86_400_000)) : DRAFT_TTL_DAYS;

  return (
    <article className="qs-draft" aria-label={t("drafts.aria")} style={isCustom ? { ["--draft-accent" as string]: gradientFor(d.custom?.color) } : undefined}>
      <div className="qs-draft-stub" aria-hidden>
        <Icon size={22} />
      </div>
      <div className="qs-draft-main">
        <p className="qs-draft-kicker">
          <span className="qs-draft-pill">{t("drafts.badge")}</span> {kind}
        </p>
        <h3>{d.name.trim() || t("drafts.untitled")}</h3>
        <p className="qs-draft-meta">
          <span>
            <Users size={13} /> {t("drafts.people", { count: people })}
          </span>
          <span>
            {t("drafts.nextStep")}: <strong>{t(`wizard.steps.${at}`)}</strong>
          </span>
          {savedAt ? (
            <span>
              <Clock size={13} /> {t("drafts.edited", { when: relativeTime(savedAt, i18n.language || "en") })}
            </span>
          ) : null}
        </p>
        <p className="qs-fine">{user ? t("drafts.syncedAccount", { days: expiresIn }) : t("drafts.syncedBrowser", { days: expiresIn })}</p>
        <div className="qs-draft-actions">
          <button type="button" className="qs-btn qs-btn-primary" onClick={onContinue}>
            {t("drafts.continue")} <ArrowRight size={16} />
          </button>
          {confirm ? (
            <button type="button" className="qs-btn qs-btn-danger" onClick={onDiscard}>
              <Trash2 size={15} /> {t("drafts.confirmDiscard")}
            </button>
          ) : (
            <button type="button" className="qs-link-btn" onClick={() => setConfirm(true)}>
              {discardLabel ?? t("drafts.discard")}
            </button>
          )}
          {extra}
        </div>
      </div>
      <ProgressRing value={done} label={t("drafts.progress", { pct: Math.round(done * 100) })} />
    </article>
  );
}
