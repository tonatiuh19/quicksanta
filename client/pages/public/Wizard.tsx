/**
 * Onboarding wizard (/start): create an exchange in ~1 minute.
 * service → design ("Create your own" only) → details → people → rules (draws only) → account (OTP, skipped when signed in) → review → launch.
 * Pro-only services stay visible with a Pro badge; launching one on a Free workspace goes through the subscription.
 * Draft lives in Redux, mirrored to localStorage and (signed in) autosaved to the account — see store/draftSync.ts.
 * Coming back with a draft shows a resume screen ("Pick up where you left off" / start new) before the steps.
 * The tenant is created implicitly on launch.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, ArrowRight, CalendarDays, ListChecks, PartyPopper, Check, Crown, Eye, EyeOff, Gift, Lock, MapPin, Plus, Rocket, Save, Send, Shuffle, Sparkles, Trash2, Users, Wallet, X,
} from "lucide-react";
import { parseParticipantLines, EMAIL_RE, normalizeEmail, type EventType } from "@shared/api";
import { Brand, ErrorNote, formatBudget, formatDate, Spinner } from "@/components/kit";
import OtpAuthCard from "@/components/OtpAuthCard";
import LanguageToggle from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe } from "@/store/slices/authSlice";
import { fetchEventTypes } from "@/store/slices/catalogSlice";
import { deleteTemplate, fetchPricing, fetchTemplates } from "@/store/slices/appSlice";
import { CUSTOM_COLORS, CUSTOM_COLOR_MAP, CUSTOM_ICONS, CUSTOM_ICON_MAP, SERVICE_ICON_MAP, gradientFor } from "@/components/customDesign";
import CheckoutCard from "@/components/billing/CheckoutCard";
import DraftCard from "@/components/DraftCard";
import { formatMoney } from "@shared/api";
import {
  addExclusion, addParticipants, clampStep, draftHasContent, draftUsesDraw, emptyDesign, goTo, launchWizard, patchDesign, patchDraft, removeExclusion, removeParticipant, resetWizard, askResume, resumeDraft, wizardPeople, wizardSteps, type WizardStep,
} from "@/store/slices/wizardSlice";

const ICONS = SERVICE_ICON_MAP;
const CURRENCIES = ["USD", "MXN", "EUR", "GBP", "CAD", "COP", "ARS", "CLP", "PEN", "BRL"];

/** Budget suggestions that make sense in each currency (USD-ish steps × a rough local scale, rounded). */
const CURRENCY_SCALE: Record<string, number> = { USD: 1, EUR: 1, GBP: 1, CAD: 1, MXN: 20, BRL: 5, PEN: 4, COP: 4000, ARS: 1000, CLP: 900 };
export function budgetChips(currency: string): number[] {
  const k = CURRENCY_SCALE[currency] ?? 1;
  const nice = (n: number) => {
    const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
    return Math.round(n / p) * p;
  };
  return [10, 20, 25, 50, 100].map((v) => nice(v * k));
}

export function stepError(step: WizardStep, d: ReturnType<typeof useDraft>, type: EventType | undefined, peopleCount: number): string | null {
  if (step === "service" && !type) return "wizard.errors.pickService";
  if (step === "design") {
    if ((d.custom?.name ?? "").trim().length < 2) return "wizard.errors.customName";
  }
  if (step === "details") {
    if (d.name.trim().length < 2) return "wizard.errors.name";
    if (d.eventTypeSlug === "custom" && d.custom?.revealMode === "together" && !d.exchangeDate) return "validation.revealNeedsDate";
    if (d.budgetMin != null && d.budgetMax != null && d.budgetMin > d.budgetMax) return "validation.budgetRange";
  }
  if (step === "people") {
    if (d.includeMe && !d.organizerName.trim()) return "wizard.errors.organizerName";
    const min = draftUsesDraw(d, type) ? 3 : 1;
    if (peopleCount < min) return "wizard.errors.minPeople";
  }
  return null;
}

function useDraft() {
  return useAppSelector((s) => s.wizard.draft);
}

export default function Wizard() {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { step, launching, error, result, resumePending } = useAppSelector((s) => s.wizard);
  const d = useDraft();
  const { user, bootstrapped } = useAppSelector((s) => s.auth);
  const catalog = useAppSelector((s) => s.catalog);
  const pricing = useAppSelector((s) => s.app.pricing);
  const [paid, setPaid] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const es = i18n.language?.startsWith("es");

  useEffect(() => {
    if (!bootstrapped) void dispatch(fetchMe());
    if (!catalog.loaded) void dispatch(fetchEventTypes());
    if (!pricing) void dispatch(fetchPricing());
  }, [bootstrapped, catalog.loaded, dispatch]);

  const location = useLocation();
  // Arriving with a draft from anywhere but a "Continue" button → the resume screen decides (before first paint).
  useLayoutEffect(() => {
    if (!(location.state as { resume?: boolean } | null)?.resume) dispatch(askResume());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ?type=… preselects a service — but never silently overwrites a draft waiting on the resume screen.
  const typeParam = params.get("type");
  useEffect(() => {
    if (typeParam && !draftHasContent(d, step)) dispatch(patchDraft({ eventTypeSlug: typeParam }));
  }, [typeParam, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (user && !d.organizerName && user.full_name && !user.full_name.includes("@")) dispatch(patchDraft({ organizerName: user.full_name }));
  }, [user, d.organizerName, dispatch]);

  const type = catalog.items.find((x) => x.slug === d.eventTypeSlug);
  const people = wizardPeople(d, user?.email);
  const freeMax = pricing?.free_max_participants ?? 20;
  const proMax = pricing?.pro_max_participants ?? 100;
  const needsPro = people.length > freeMax;
  const tooBig = people.length > proMax;
  // The workspace the server will launch into (first active organizer workspace) — prefer the active one if it qualifies.
  const organizerWs =
    user?.memberships.find((m) => m.tenant_id === user.active_tenant_id && m.role === "organizer" && m.tenant_status === "active") ??
    user?.memberships.find((m) => m.role === "organizer" && m.tenant_status === "active");
  const workspacePro = Boolean(organizerWs && organizerWs.tenant_plan !== "free");
  const typeNeedsPro = Boolean(type?.requires_pro);
  const usesDraw = draftUsesDraw(d, type);
  const plan = needsPro || typeNeedsPro ? "pro" : d.plan ?? "free";
  const isCustom = d.eventTypeSlug === "custom";
  const wishlistMode = type?.wishlist_mode ?? "off";
  const design = d.custom ?? emptyDesign();
  const templates = useAppSelector((s) => s.app.templates);
  const displayName = isCustom ? design.name || t("wizard.design.namePh") : type ? (es ? type.name_es : type.name_en) : "QuickSanta";
  const price = pricing ? formatMoney(pricing.pro_price_cents, pricing.pro_currency, i18n.language.startsWith("es") ? "es-MX" : "en-US") : "…";
  const steps = wizardSteps(d, type, Boolean(user));
  const idx = Math.max(0, steps.indexOf(step));

  // A resumed draft can point at a step this flow skips (e.g. "account" after signing in): move to the closest one.
  useEffect(() => {
    if (catalog.loaded && !steps.includes(step)) dispatch(goTo(clampStep(step, steps)));
  }, [catalog.loaded, step, steps.join(), dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (organizerWs && workspacePro) void dispatch(fetchTemplates());
  }, [organizerWs?.tenant_id, workspacePro, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps


  const next = () => {
    const err = stepError(step, d, type, people.length);
    if (err) return setLocalError(err);
    setLocalError(null);
    dispatch(goTo(steps[Math.min(idx + 1, steps.length - 1)]));
  };
  const back = () => {
    setLocalError(null);
    dispatch(goTo(steps[Math.max(idx - 1, 0)]));
  };

  const launch = async () => {
    const r = await dispatch(launchWizard({ ...d, plan, participants: d.participants.filter((p) => p.email !== user?.email) }));
    if (launchWizard.fulfilled.match(r)) await dispatch(fetchMe());
  };

  // Pro: the exchange exists (pending payment) — pay now, then celebrate.
  if (result?.payment_required && !paid) {
    return (
      <div className="qs-wizard">
        <header className="qs-auth-top">
          <Brand />
          <LanguageToggle />
        </header>
        <section className="qs-wizard-panel qs-pay-panel">
          <p className="qs-kicker">
            <Sparkles size={13} /> {t("checkout.kicker")}
          </p>
          <h2>{t("checkout.heading")}</h2>
          <p className="qs-page-sub">{t("checkout.sub", { count: people.length })}</p>
          <CheckoutCard
            mode="subscribe"
            label={user?.memberships.find((m) => m.tenant_id === result.tenant_id)?.tenant_name ?? d.name}
            amountCents={pricing?.pro_price_cents ?? 890}
            currency={pricing?.pro_currency ?? "usd"}
            payerName={d.organizerName || user?.full_name}
            onDone={() => setPaid(true)}
          />
          <button
            type="button"
            className="qs-link-btn"
            onClick={() => {
              dispatch(resetWizard());
              navigate(`/app/events/${result.event_id}`);
            }}
          >
            {t("checkout.later")}
          </button>
        </section>
      </div>
    );
  }

  if (result) {
    return (
      <div className="qs-wizard qs-wizard--done">
        <Confetti />
        <div className="qs-done-card">
          <div className="qs-done-icon">
            <PartyPopper size={34} />
          </div>
          <h1>{t("wizard.done.title")}</h1>
          <p>{t("wizard.done.body", { count: result.invited })}</p>
          <div className="qs-row center">
            <Button
              className="qs-btn-primary"
              onClick={() => {
                dispatch(resetWizard());
                navigate(`/app/events/${result.event_id}`);
              }}
            >
              {t("wizard.done.manage")} <ArrowRight />
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                dispatch(resetWizard());
                navigate("/app");
              }}
            >
              {t("wizard.done.dashboard")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // A draft came back (reload, another device, the dashboard): continue it or start fresh.
  if (resumePending) {
    return (
      <div className="qs-wizard">
        <header className="qs-auth-top">
          <Link to="/">
            <Brand />
          </Link>
          <div className="qs-row">
            <LanguageToggle />
            <Link className="qs-link-btn" to={user ? "/app" : "/"}>
              {t("wizard.exit")}
            </Link>
          </div>
        </header>
        <section className="qs-wizard-panel qs-resume">
          <p className="qs-kicker">
            <Sparkles size={13} /> {t("drafts.resumeKicker")}
          </p>
          <h2>{t("drafts.resumeTitle")}</h2>
          <p className="qs-page-sub">{t("drafts.resumeSub")}</p>
          <DraftCard
            onContinue={() => dispatch(resumeDraft())}
            onDiscard={() => {
              dispatch(resetWizard());
              if (typeParam) dispatch(patchDraft({ eventTypeSlug: typeParam }));
            }}
            discardLabel={t("drafts.startNew")}
          />
          <p className="qs-fine">{t("drafts.oneDraft")}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="qs-wizard">
      <header className="qs-auth-top">
        <Link to="/">
          <Brand />
        </Link>
        <div className="qs-row">
          <LanguageToggle />
          {user ? (
            <Link className="qs-link-btn" to="/app">
              {t("wizard.exit")}
            </Link>
          ) : (
            <Link className="qs-link-btn" to="/login">
              {t("landing.signIn")}
            </Link>
          )}
        </div>
      </header>

      <ol className="qs-steps" aria-label={t("wizard.progress")}>
        {steps.map((s, i) => (
          <li key={s} className={i < idx ? "is-done" : i === idx ? "is-current" : ""} aria-current={i === idx ? "step" : undefined}>
            <button type="button" disabled={i > idx} onClick={() => dispatch(goTo(s))}>
              <span className="qs-step-dot">{i < idx ? <Check size={13} /> : i + 1}</span>
              <span className="qs-step-label">{t(`wizard.steps.${s}`)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="qs-step-bar" aria-hidden>
        <span style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
      </div>
      {/* Phones: compact step label + slim summary strip instead of the dots row and the big ticket. */}
      <div className="qs-step-mobile" aria-hidden>
        <span>{t("wizard.stepOf", { n: idx + 1, total: steps.length })}</span>
        <strong>{t(`wizard.steps.${step}`)}</strong>
      </div>
      <div className="qs-mini-ticket" style={isCustom ? { background: gradientFor(design.color) } : undefined} aria-hidden>
        <span className="qs-mini-ticket-kind">{displayName}</span>
        <strong>{d.name || t("wizard.details.namePh")}</strong>
        <span className="qs-mini-ticket-people">
          <Users size={13} /> {people.length}
        </span>
      </div>

      <div className="qs-wizard-body">
        <section className="qs-wizard-panel" key={step}>
          {step === "service" && (
            <>
              <h2>{t("wizard.service.title")}</h2>
              <p className="qs-page-sub">{t("wizard.service.sub")}</p>
              {catalog.loading && !catalog.items.length ? <Spinner label={t("common.loading")} /> : null}
              <ErrorNote error={catalog.error} onRetry={() => void dispatch(fetchEventTypes())} />
              {templates.length ? (
                <div className="qs-templates">
                  <p className="qs-kicker">
                    <Save size={13} /> {t("wizard.design.yourTemplates")}
                  </p>
                  <div className="qs-template-row">
                    {templates.map((tp) => {
                      const TIcon = CUSTOM_ICON_MAP[tp.icon] ?? Sparkles;
                      return (
                        <div key={tp.id} className="qs-template" style={{ background: gradientFor(tp.color) }}>
                          <button
                            type="button"
                            className="qs-template-use"
                            onClick={() => {
                              dispatch(
                                patchDraft({
                                  eventTypeSlug: "custom",
                                  allowWishlists: tp.allow_wishlists,
                                  budgetMin: tp.budget_min,
                                  budgetMax: tp.budget_max,
                                  currency: tp.currency,
                                  custom: { name: tp.name, icon: tp.icon, color: tp.color, matchMode: tp.match_mode, themeRules: tp.theme_rules ?? "", revealMode: tp.reveal_mode },
                                  saveTemplate: false,
                                  exclusions: tp.match_mode === "draw" ? d.exclusions : [],
                                }),
                              );
                              dispatch(goTo("design"));
                            }}
                          >
                            <TIcon size={18} /> {tp.name}
                          </button>
                          <button type="button" className="qs-template-del" aria-label={t("common.removeX", { name: tp.name })} onClick={() => void dispatch(deleteTemplate(tp.id))}>
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="qs-choice-grid" role="radiogroup" aria-label={t("wizard.service.title")}>
                {catalog.items.map((et) => {
                  const Icon = ICONS[et.icon] ?? Gift;
                  const selected = et.slug === d.eventTypeSlug;
                  const locked = et.requires_pro && !workspacePro;
                  const custom = et.slug === "custom";
                  return (
                    <button
                      key={et.slug}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`qs-choice${selected ? " is-selected" : ""}${custom ? " is-custom" : ""}${locked ? " is-locked" : ""}`}
                      onClick={() => dispatch(patchDraft({ eventTypeSlug: et.slug, exclusions: et.uses_draw ? d.exclusions : [] }))}
                      onDoubleClick={next}
                    >
                      <span className="qs-choice-icon">
                        <Icon size={22} />
                      </span>
                      <strong>{es ? et.name_es : et.name_en}</strong>
                      <span className="qs-choice-desc">{es ? et.description_es : et.description_en}</span>
                      {et.requires_pro ? (
                        <span className={`qs-pro-tag${locked ? " is-locked" : ""}`}>
                          {locked ? <Lock size={11} /> : <Crown size={11} />} Pro
                        </span>
                      ) : null}
                      {selected ? <Check className="qs-choice-check" size={18} /> : null}
                    </button>
                  );
                })}
              </div>
              {type?.requires_pro && !workspacePro ? (
                <p className="qs-fine qs-pro-note">
                  <Crown size={14} /> {t("wizard.service.proNote", { price })}
                </p>
              ) : null}
            </>
          )}

          {step === "design" && (
            <>
              <h2>{t("wizard.design.title")}</h2>
              <p className="qs-page-sub">{t("wizard.design.sub")}</p>
              <div className="qs-form">
                <label className="qs-field">
                  <span>{t("wizard.design.name")}</span>
                  <input value={design.name} maxLength={80} onChange={(e) => dispatch(patchDesign({ name: e.target.value }))} placeholder={t("wizard.design.namePh")} autoFocus />
                </label>
                <div className="qs-field">
                  <span>{t("wizard.design.icon")}</span>
                  <div className="qs-icon-pick" role="radiogroup" aria-label={t("wizard.design.icon")}>
                    {CUSTOM_ICONS.map((ic) => {
                      const I = CUSTOM_ICON_MAP[ic];
                      return (
                        <button key={ic} type="button" role="radio" aria-checked={design.icon === ic} aria-label={ic} className={design.icon === ic ? "is-on" : ""} onClick={() => dispatch(patchDesign({ icon: ic }))}>
                          <I size={18} />
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="qs-field">
                  <span>{t("wizard.design.color")}</span>
                  <div className="qs-color-pick" role="radiogroup" aria-label={t("wizard.design.color")}>
                    {CUSTOM_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={design.color === c}
                        aria-label={t(`wizard.design.colors.${c}`)}
                        className={design.color === c ? "is-on" : ""}
                        style={{ background: `linear-gradient(135deg, ${CUSTOM_COLOR_MAP[c][0]}, ${CUSTOM_COLOR_MAP[c][1]})` }}
                        onClick={() => dispatch(patchDesign({ color: c }))}
                      />
                    ))}
                  </div>
                </div>
                <div className="qs-field">
                  <span>{t("wizard.design.match")}</span>
                  <div className="qs-mode-pick" role="radiogroup" aria-label={t("wizard.design.match")}>
                    {(["draw", "none"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={design.matchMode === m}
                        className={`qs-mode${design.matchMode === m ? " is-on" : ""}`}
                        onClick={() => {
                          dispatch(patchDesign(m === "none" ? { matchMode: m, revealMode: "private" } : { matchMode: m }));
                          if (m === "none") dispatch(patchDraft({ exclusions: [] }));
                        }}
                      >
                        {m === "draw" ? <Shuffle size={18} /> : <Gift size={18} />}
                        <strong>{t(`wizard.design.modes.${m}.title`)}</strong>
                        <span>{t(`wizard.design.modes.${m}.body`)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {design.matchMode === "draw" ? (
                  <div className="qs-field">
                    <span>{t("wizard.design.reveal")}</span>
                    <div className="qs-mode-pick" role="radiogroup" aria-label={t("wizard.design.reveal")}>
                      {(["private", "together"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="radio"
                          aria-checked={design.revealMode === m}
                          className={`qs-mode${design.revealMode === m ? " is-on" : ""}`}
                          onClick={() => dispatch(patchDesign({ revealMode: m }))}
                        >
                          {m === "private" ? <Eye size={18} /> : <EyeOff size={18} />}
                          <strong>{t(`wizard.design.reveals.${m}.title`)}</strong>
                          <span>{t(`wizard.design.reveals.${m}.body`)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <label className="qs-field">
                  <span>{t("wizard.design.rules")}</span>
                  <textarea rows={3} maxLength={500} value={design.themeRules} onChange={(e) => dispatch(patchDesign({ themeRules: e.target.value }))} placeholder={t("wizard.design.rulesPh")} />
                </label>
                <label className="qs-switch">
                  <input type="checkbox" checked={Boolean(d.saveTemplate)} onChange={(e) => dispatch(patchDraft({ saveTemplate: e.target.checked }))} />
                  <span>
                    <Save size={14} /> {t("wizard.design.saveTemplate")}
                  </span>
                </label>
                {d.saveTemplate && templates.some((tp) => tp.name.trim().toLowerCase() === design.name.trim().toLowerCase()) ? (
                  <p className="qs-fine qs-warn">{t("wizard.design.templateOverwrite", { name: design.name })}</p>
                ) : null}
              </div>
            </>
          )}

          {step === "details" && (
            <>
              <h2>{t("wizard.details.title")}</h2>
              <p className="qs-page-sub">{t("wizard.details.sub")}</p>
              <div className="qs-form qs-form-grid">
                <label className="qs-field span-2">
                  <span>{t("wizard.details.name")}</span>
                  <input value={d.name} maxLength={140} onChange={(e) => dispatch(patchDraft({ name: e.target.value }))} placeholder={t("wizard.details.namePh")} autoFocus />
                </label>
                <label className="qs-field">
                  <span>
                    <CalendarDays size={14} /> {t("wizard.details.date")}
                  </span>
                  <input type="date" value={d.exchangeDate ?? ""} onChange={(e) => dispatch(patchDraft({ exchangeDate: e.target.value || null }))} />
                </label>
                <label className="qs-field">
                  <span>
                    <MapPin size={14} /> {t("wizard.details.location")}
                  </span>
                  <input value={d.location ?? ""} maxLength={200} onChange={(e) => dispatch(patchDraft({ location: e.target.value || null }))} placeholder={t("wizard.details.locationPh")} />
                </label>
                <div className="qs-field span-2">
                  <span>
                    <Wallet size={14} /> {t("wizard.details.budget")}
                  </span>
                  <div className="qs-budget">
                    <input type="number" min={0} inputMode="decimal" aria-label={t("wizard.details.min")} placeholder={t("wizard.details.min")} value={d.budgetMin ?? ""} onChange={(e) => dispatch(patchDraft({ budgetMin: e.target.value === "" ? null : Number(e.target.value) }))} />
                    <span>–</span>
                    <input type="number" min={0} inputMode="decimal" aria-label={t("wizard.details.max")} placeholder={t("wizard.details.max")} value={d.budgetMax ?? ""} onChange={(e) => dispatch(patchDraft({ budgetMax: e.target.value === "" ? null : Number(e.target.value) }))} />
                    <select value={d.currency} aria-label={t("wizard.details.currency")} onChange={(e) => dispatch(patchDraft({ currency: e.target.value }))}>
                      {CURRENCIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div className="qs-chips">
                    {budgetChips(d.currency).map((v) => (
                      <button key={v} type="button" className={`qs-chip${d.budgetMax === v ? " is-on" : ""}`} onClick={() => dispatch(patchDraft({ budgetMin: Math.round(v * 0.75), budgetMax: v }))}>
                        ~{v.toLocaleString(es ? "es-MX" : "en-US")} {d.currency}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="qs-field span-2">
                  <span>{t("wizard.details.description")}</span>
                  <textarea rows={3} maxLength={2000} value={d.description ?? ""} onChange={(e) => dispatch(patchDraft({ description: e.target.value }))} placeholder={t("wizard.details.descriptionPh")} />
                </label>
                {wishlistMode === "optional" ? (
                  <label className="qs-switch span-2">
                    <input type="checkbox" checked={d.allowWishlists} onChange={(e) => dispatch(patchDraft({ allowWishlists: e.target.checked }))} />
                    <span>{t("wizard.details.wishlists")}</span>
                  </label>
                ) : wishlistMode === "required" ? (
                  <p className="qs-fine span-2 qs-wish-note">
                    <ListChecks size={14} /> {t("wizard.details.wishlistsIncluded")}
                  </p>
                ) : null}
              </div>
            </>
          )}

          {step === "people" && <PeopleStep />}
          {step === "rules" && <RulesStep />}

          {step === "account" && (
            <OtpAuthCard
              askName
              title={t("wizard.account.title")}
              subtitle={t("wizard.account.sub")}
              onSignedIn={() => dispatch(goTo("review"))}
            />
          )}

          {step === "review" && (
            <>
              <h2>{t("wizard.review.title")}</h2>
              <p className="qs-page-sub">{t("wizard.review.sub")}</p>
              <dl className="qs-review">
                <div>
                  <dt>{t("wizard.steps.service")}</dt>
                  <dd>{displayName}</dd>
                </div>
                <div>
                  <dt>{t("wizard.details.name")}</dt>
                  <dd>{d.name}</dd>
                </div>
                <div>
                  <dt>{t("wizard.details.date")}</dt>
                  <dd>{formatDate(d.exchangeDate, i18n.language)}</dd>
                </div>
                <div>
                  <dt>{t("wizard.details.budget")}</dt>
                  <dd>{formatBudget(d.budgetMin ?? null, d.budgetMax ?? null, d.currency)}</dd>
                </div>
                <div>
                  <dt>{t("wizard.steps.people")}</dt>
                  <dd>{t("wizard.review.people", { count: people.length })}</dd>
                </div>
                {type?.uses_draw ? (
                  <div>
                    <dt>{t("wizard.steps.rules")}</dt>
                    <dd>{t("wizard.review.rules", { count: d.exclusions.length })}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="qs-plan-pick" role="radiogroup" aria-label={t("checkout.planLabel")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={plan === "free"}
                  disabled={needsPro || typeNeedsPro}
                  className={`qs-plan-opt${plan === "free" ? " is-selected" : ""}`}
                  onClick={() => dispatch(patchDraft({ plan: "free" }))}
                >
                  <strong>{t("landing.pricing.free.name")}</strong>
                  <span className="qs-plan-opt-price">$0</span>
                  <span>{t("checkout.upTo", { count: freeMax })}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={plan === "pro"}
                  className={`qs-plan-opt is-pro${plan === "pro" ? " is-selected" : ""}`}
                  onClick={() => dispatch(patchDraft({ plan: "pro" }))}
                >
                  <strong>
                    {t("landing.pricing.pro.name")} <Sparkles size={14} />
                  </strong>
                  <span className="qs-plan-opt-price">
                    {price}
                    <small>/{t("billing.month")}</small>
                  </span>
                  <span>{t("checkout.upTo", { count: proMax })}</span>
                </button>
              </div>
              {needsPro && !tooBig ? <p className="qs-fine qs-warn">{t("checkout.needsPro", { count: people.length, max: freeMax })}</p> : null}
              {typeNeedsPro && !workspacePro ? <p className="qs-fine qs-warn">{t("wizard.review.proService", { name: displayName })}</p> : null}
              {workspacePro && plan === "pro" ? <p className="qs-fine">{t("wizard.review.coveredByPro")}</p> : null}
              {tooBig ? (
                <p className="qs-error" role="alert">
                  {t("checkout.enterprise", { max: proMax })}
                </p>
              ) : null}
              <label className="qs-switch">
                <input type="checkbox" checked={d.sendInvites} onChange={(e) => dispatch(patchDraft({ sendInvites: e.target.checked }))} />
                <span>
                  <Send size={14} /> {t("wizard.review.sendInvites")}
                </span>
              </label>
              <ErrorNote error={error} opts={{ min: type?.uses_draw ? 3 : 1 }} />
            </>
          )}

          <ErrorNote error={localError} opts={{ min: type?.uses_draw === false ? 1 : 3 }} />

          {step !== "account" ? (
            <div className="qs-wizard-nav">
              <Button variant="ghost" onClick={back} disabled={idx === 0}>
                <ArrowLeft /> {t("common.back")}
              </Button>
              {step === "review" ? (
                <Button className="qs-btn-primary qs-btn-launch" onClick={() => void launch()} disabled={launching || !user || tooBig}>
                  <Rocket /> {launching ? t("wizard.review.launching") : plan === "pro" && !workspacePro ? t("checkout.launchPay", { price }) : t("wizard.review.launch")}
                </Button>
              ) : (
                <Button className="qs-btn-primary" onClick={next}>
                  {t("common.next")} <ArrowRight />
                </Button>
              )}
            </div>
          ) : (
            <div className="qs-wizard-nav">
              <Button variant="ghost" onClick={back}>
                <ArrowLeft /> {t("common.back")}
              </Button>
            </div>
          )}
        </section>

        <aside className="qs-wizard-preview" aria-label={t("wizard.preview")}>
          <div className="qs-ticket" style={isCustom ? { background: gradientFor(design.color) } : undefined}>
            <span className="qs-kicker">
              {isCustom ? (() => {
                const I = CUSTOM_ICON_MAP[design.icon] ?? Sparkles;
                return <I size={13} />;
              })() : <Sparkles size={13} />}{" "}
              {displayName}
            </span>
            <h3>{d.name || t("wizard.details.namePh")}</h3>
            <ul>
              <li>
                <CalendarDays size={15} /> {formatDate(d.exchangeDate, i18n.language)}
              </li>
              <li>
                <Wallet size={15} /> {formatBudget(d.budgetMin ?? null, d.budgetMax ?? null, d.currency)}
              </li>
              <li>
                <Users size={15} /> {t("wizard.review.people", { count: people.length })}
              </li>
              {isCustom && design.themeRules ? <li className="qs-ticket-rules">“{design.themeRules}”</li> : null}
            </ul>
            <div className="qs-ticket-avatars">
              {people.slice(0, 8).map((p, i) => (
                <span key={`${p.email}-${i}`} title={p.name}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              {people.length > 8 ? <span>+{people.length - 8}</span> : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PeopleStep() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const d = useDraft();
  const user = useAppSelector((s) => s.auth.user);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [bulk, setBulk] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);

  const addOne = (e: FormEvent) => {
    e.preventDefault();
    const em = normalizeEmail(email);
    if (!EMAIL_RE.test(em)) return setErr("validation.email");
    if (!name.trim()) return setErr("wizard.errors.personName");
    setErr(null);
    dispatch(addParticipants([{ name: name.trim(), email: em }]));
    setName("");
    setEmail("");
  };

  const addBulk = () => {
    const r = parseParticipantLines(bulk);
    dispatch(addParticipants(r.valid));
    setInvalid(r.invalid);
    setBulk(r.invalid.join("\n"));
    if (!r.invalid.length) setShowBulk(false);
  };

  return (
    <>
      <h2>{t("wizard.people.title")}</h2>
      <p className="qs-page-sub">{t("wizard.people.sub")}</p>
      <div className="qs-form">
        <label className="qs-switch">
          <input type="checkbox" checked={d.includeMe} onChange={(e) => dispatch(patchDraft({ includeMe: e.target.checked, exclusions: [] }))} />
          <span>{t("wizard.people.includeMe")}</span>
        </label>
        <label className="qs-field">
          <span>{t("wizard.people.organizerName")}</span>
          <input value={d.organizerName} maxLength={120} onChange={(e) => dispatch(patchDraft({ organizerName: e.target.value }))} autoComplete="name" />
        </label>
        <form className="qs-add-person" onSubmit={addOne}>
          <input aria-label={t("wizard.people.name")} placeholder={t("wizard.people.name")} value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label={t("wizard.people.email")} placeholder={t("wizard.people.email")} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" variant="outline">
            <Plus /> {t("wizard.people.add")}
          </Button>
        </form>
        <ErrorNote error={err} />
        <button type="button" className="qs-link-btn" onClick={() => setShowBulk((v) => !v)}>
          {showBulk ? t("common.cancel") : t("wizard.people.pasteList")}
        </button>
        {showBulk ? (
          <div className="qs-bulk">
            <textarea rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"Ana Pérez <ana@mail.com>\nbob@mail.com\nCarla, carla@mail.com"} aria-label={t("wizard.people.pasteList")} />
            {invalid.length ? <p className="qs-fine qs-warn">{t("wizard.people.invalidLines", { count: invalid.length })}</p> : null}
            <Button type="button" variant="outline" onClick={addBulk} disabled={!bulk.trim()}>
              {t("wizard.people.addAll")}
            </Button>
          </div>
        ) : null}
        <ul className="qs-people" aria-label={t("wizard.steps.people")}>
          {d.includeMe ? (
            <li className="is-me">
              <span className="qs-avatar">{(d.organizerName || "?").slice(0, 1).toUpperCase()}</span>
              <span className="qs-people-copy">
                <strong>{d.organizerName || t("wizard.people.you")}</strong>
                <span>{user?.email ?? t("wizard.people.youHint")}</span>
              </span>
              <span className="qs-badge qs-badge--blue">{t("role.organizer")}</span>
            </li>
          ) : null}
          {d.participants
            .filter((p) => p.email !== user?.email)
            .map((p) => (
              <li key={p.email}>
                <span className="qs-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="qs-people-copy">
                  <strong>{p.name}</strong>
                  <span>{p.email}</span>
                </span>
                <button type="button" className="qs-icon-btn" aria-label={t("common.removeX", { name: p.name })} onClick={() => dispatch(removeParticipant(p.email))}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
        </ul>
      </div>
    </>
  );
}

function RulesStep() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const d = useDraft();
  const user = useAppSelector((s) => s.auth.user);
  const people = useMemo(() => wizardPeople(d, user?.email), [d, user?.email]);
  const [a, setA] = useState(people[0]?.ref ?? "");
  const [b, setB] = useState(people[1]?.ref ?? "");
  const nameOf = (ref: string) => people.find((p) => p.ref === ref)?.name ?? ref;
  const [both, setBoth] = useState(true);
  return (
    <>
      <h2>{t("wizard.rules.title")}</h2>
      <p className="qs-page-sub">{t("wizard.rules.sub")}</p>
      <div className="qs-rule-builder">
        <select value={a} onChange={(e) => setA(e.target.value)} aria-label={t("wizard.rules.giver")}>
          {people.map((p) => (
            <option key={p.ref} value={p.ref}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="qs-rule-arrow">{both ? "⇄" : "→"}</span>
        <select value={b} onChange={(e) => setB(e.target.value)} aria-label={t("wizard.rules.receiver")}>
          {people.map((p) => (
            <option key={p.ref} value={p.ref}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="qs-switch">
          <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
          <span>{t("wizard.rules.bothWays")}</span>
        </label>
        <Button type="button" variant="outline" disabled={!a || !b || a === b} onClick={() => dispatch(addExclusion({ a, b, bidirectional: both }))}>
          <Plus /> {t("wizard.rules.add")}
        </Button>
      </div>
      {d.exclusions.length === 0 ? <p className="qs-fine">{t("wizard.rules.none")}</p> : null}
      <ul className="qs-rules">
        {d.exclusions.map((x, i) => (
          <li key={i}>
            <span>
              <strong>{nameOf(x.a)}</strong> {x.bidirectional ? "⇄" : "→"} <strong>{nameOf(x.b)}</strong>
              <em> {t("wizard.rules.never")}</em>
            </span>
            <button type="button" className="qs-icon-btn" aria-label={t("common.remove")} onClick={() => dispatch(removeExclusion(i))}>
              <X size={16} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Confetti() {
  const pieces = useMemo(
    () => Array.from({ length: 60 }, (_, i) => ({ left: Math.random() * 100, delay: Math.random() * 1.2, dur: 2.4 + Math.random() * 1.6, hue: [0, 45, 140, 210][i % 4], rot: Math.random() * 360 })),
    [],
  );
  return (
    <div className="qs-confetti" aria-hidden>
      {pieces.map((p, i) => (
        <span key={i} style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, background: `hsl(${p.hue} 80% 55%)`, transform: `rotate(${p.rot}deg)` }} />
      ))}
    </div>
  );
}
