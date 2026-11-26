/**
 * Onboarding wizard (/start): create an exchange in ~1 minute.
 * service → details → people → rules → account (OTP, skipped when signed in) → review → launch.
 * Draft lives in Redux (persisted to localStorage), so the OTP round trip or a reload never loses work.
 * The tenant is created implicitly on launch.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, Cookie, Gift, ListChecks, MapPin, PartyPopper, Plus, Rocket, Send, Sparkles, Trash2, Users, Wallet, X,
} from "lucide-react";
import { parseParticipantLines, EMAIL_RE, normalizeEmail, type EventType } from "@shared/api";
import { Brand, ErrorNote, formatBudget, formatDate, Spinner } from "@/components/kit";
import OtpAuthCard from "@/components/OtpAuthCard";
import LanguageToggle from "@/components/LanguageToggle";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMe } from "@/store/slices/authSlice";
import { fetchEventTypes } from "@/store/slices/catalogSlice";
import { fetchPricing } from "@/store/slices/appSlice";
import CheckoutCard from "@/components/billing/CheckoutCard";
import { formatMoney } from "@shared/api";
import {
  WIZARD_STEPS, addExclusion, addParticipants, goTo, launchWizard, patchDraft, removeExclusion, removeParticipant, resetWizard, wizardPeople, type WizardStep,
} from "@/store/slices/wizardSlice";

const ICONS: Record<string, typeof Gift> = { gift: Gift, party: PartyPopper, list: ListChecks, book: BookOpen, cookie: Cookie };
const CURRENCIES = ["USD", "MXN", "EUR", "GBP", "CAD", "COP", "ARS", "CLP", "PEN", "BRL"];

export function stepError(step: WizardStep, d: ReturnType<typeof useDraft>, type: EventType | undefined, peopleCount: number): string | null {
  if (step === "service" && !type) return "wizard.errors.pickService";
  if (step === "details") {
    if (d.name.trim().length < 2) return "wizard.errors.name";
    if (d.budgetMin != null && d.budgetMax != null && d.budgetMin > d.budgetMax) return "validation.budgetRange";
  }
  if (step === "people") {
    if (d.includeMe && !d.organizerName.trim()) return "wizard.errors.organizerName";
    const min = type?.uses_draw === false ? 1 : 3;
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
  const { step, launching, error, result } = useAppSelector((s) => s.wizard);
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

  useEffect(() => {
    const type = params.get("type");
    if (type) dispatch(patchDraft({ eventTypeSlug: type }));
  }, [params, dispatch]);

  useEffect(() => {
    if (user && !d.organizerName && user.full_name && !user.full_name.includes("@")) dispatch(patchDraft({ organizerName: user.full_name }));
  }, [user, d.organizerName, dispatch]);

  const type = catalog.items.find((x) => x.slug === d.eventTypeSlug);
  const people = wizardPeople(d, user?.email);
  const freeMax = pricing?.free_max_participants ?? 20;
  const proMax = pricing?.pro_max_participants ?? 100;
  const needsPro = people.length > freeMax;
  const tooBig = people.length > proMax;
  const plan = needsPro ? "pro" : d.plan ?? "free";
  const price = pricing ? formatMoney(pricing.pro_price_cents, pricing.pro_currency, i18n.language.startsWith("es") ? "es-MX" : "en-US") : "$8.90";
  const steps = WIZARD_STEPS.filter((s) => !(s === "account" && user) && !(s === "rules" && type && !type.uses_draw));
  const idx = Math.max(0, steps.indexOf(step));

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

      <div className="qs-wizard-body">
        <section className="qs-wizard-panel" key={step}>
          {step === "service" && (
            <>
              <h2>{t("wizard.service.title")}</h2>
              <p className="qs-page-sub">{t("wizard.service.sub")}</p>
              {catalog.loading && !catalog.items.length ? <Spinner label={t("common.loading")} /> : null}
              <ErrorNote error={catalog.error} onRetry={() => void dispatch(fetchEventTypes())} />
              <div className="qs-choice-grid" role="radiogroup" aria-label={t("wizard.service.title")}>
                {catalog.items.map((et) => {
                  const Icon = ICONS[et.icon] ?? Gift;
                  const selected = et.slug === d.eventTypeSlug;
                  return (
                    <button
                      key={et.slug}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`qs-choice${selected ? " is-selected" : ""}`}
                      onClick={() => dispatch(patchDraft({ eventTypeSlug: et.slug, exclusions: et.uses_draw ? d.exclusions : [] }))}
                      onDoubleClick={next}
                    >
                      <span className="qs-choice-icon">
                        <Icon size={22} />
                      </span>
                      <strong>{es ? et.name_es : et.name_en}</strong>
                      <span>{es ? et.description_es : et.description_en}</span>
                      {selected ? <Check className="qs-choice-check" size={18} /> : null}
                    </button>
                  );
                })}
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
                    {[10, 20, 25, 50, 100].map((v) => (
                      <button key={v} type="button" className={`qs-chip${d.budgetMax === v ? " is-on" : ""}`} onClick={() => dispatch(patchDraft({ budgetMin: Math.round(v * 0.75), budgetMax: v }))}>
                        ~{v} {d.currency}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="qs-field span-2">
                  <span>{t("wizard.details.description")}</span>
                  <textarea rows={3} maxLength={2000} value={d.description ?? ""} onChange={(e) => dispatch(patchDraft({ description: e.target.value }))} placeholder={t("wizard.details.descriptionPh")} />
                </label>
                <label className="qs-switch span-2">
                  <input type="checkbox" checked={d.allowWishlists} onChange={(e) => dispatch(patchDraft({ allowWishlists: e.target.checked }))} />
                  <span>{t("wizard.details.wishlists")}</span>
                </label>
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
                  <dd>{type ? (es ? type.name_es : type.name_en) : d.eventTypeSlug}</dd>
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
                  disabled={needsPro}
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
                  <Rocket /> {launching ? t("wizard.review.launching") : plan === "pro" ? t("checkout.launchPay", { price }) : t("wizard.review.launch")}
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
          <div className="qs-ticket">
            <span className="qs-kicker">
              <Sparkles size={13} /> {type ? (es ? type.name_es : type.name_en) : "QuickSanta"}
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
