import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight, BookOpen, Check, ChevronDown, Cookie, Gift, ListChecks, Lock, Mail, PartyPopper, ShieldCheck, Shuffle, Sparkles, Users, Wand2,
} from "lucide-react";
import { Brand } from "@/components/kit";
import LanguageToggle from "@/components/LanguageToggle";

const SERVICES = [
  { key: "secret_santa", icon: Gift },
  { key: "white_elephant", icon: PartyPopper },
  { key: "wishlist_exchange", icon: ListChecks },
  { key: "book_swap", icon: BookOpen },
  { key: "cookie_swap", icon: Cookie },
  { key: "custom", icon: Wand2 },
];
const FREE_SERVICES = new Set(["secret_santa", "white_elephant"]);

const DEMO_PEOPLE = ["Ana", "Bruno", "Carla", "Diego", "Elena", "Fer"];
/** A valid derangement for the hero demo (index → index). */
const DEMO_DRAWS = [
  [2, 4, 0, 5, 1, 3],
  [3, 0, 4, 1, 5, 2],
  [5, 3, 1, 4, 2, 0],
];
const COLORS = ["#dc2626", "#d6a23a", "#16a34a", "#2563eb", "#9333ea", "#ea580c"];

/** Loops through draws: names orbit, lines connect giver → receiver, then a gift pops. */
function HeroDraw() {
  const { t } = useTranslation();
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<"idle" | "shuffle" | "drawn">("idle");
  useEffect(() => {
    const seq = [
      setTimeout(() => setPhase("shuffle"), 600),
      setTimeout(() => setPhase("drawn"), 2200),
      setTimeout(() => {
        setPhase("idle");
        setRound((r) => (r + 1) % DEMO_DRAWS.length);
      }, 5600),
    ];
    return () => seq.forEach(clearTimeout);
  }, [round]);
  const draw = DEMO_DRAWS[round];
  const pos = (i: number) => {
    const a = (i / DEMO_PEOPLE.length) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(a) * 36, y: 50 + Math.sin(a) * 36 };
  };
  return (
    <div className={`qs-hero-demo is-${phase}`} aria-hidden>
      <svg viewBox="0 0 100 100" className="qs-hero-lines">
        {phase === "drawn" &&
          draw.map((r, g) => {
            const a = pos(g);
            const b = pos(r);
            return (
              <path
                key={`${round}-${g}`}
                d={`M${a.x},${a.y} Q50,50 ${b.x},${b.y}`}
                stroke={COLORS[g]}
                style={{ animationDelay: `${g * 0.18}s` }}
              />
            );
          })}
      </svg>
      <div className="qs-hero-center">
        <span className="qs-hero-gift">
          <Gift size={34} />
        </span>
        <strong>{phase === "drawn" ? t("landing.demo.done") : phase === "shuffle" ? t("landing.demo.shuffling") : t("landing.demo.ready")}</strong>
      </div>
      {DEMO_PEOPLE.map((name, i) => {
        const p = pos(i);
        return (
          <span key={name} className="qs-hero-person" style={{ left: `${p.x}%`, top: `${p.y}%`, ["--c" as any]: COLORS[i], animationDelay: `${i * 0.08}s` }}>
            <span className="qs-hero-avatar">{name[0]}</span>
            <span className="qs-hero-name">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

function StepVisual({ step }: { step: number }) {
  if (step === 0)
    return (
      <div className="qs-sv qs-sv-wizard">
        <div className="qs-sv-bar">
          <span />
        </div>
        <div className="qs-sv-field">
          <span className="qs-sv-typing">Family Christmas 2026</span>
        </div>
        <div className="qs-sv-chips">
          <span>~25 USD</span>
          <span className="on">~50 USD</span>
          <span>~100 USD</span>
        </div>
      </div>
    );
  if (step === 1)
    return (
      <div className="qs-sv qs-sv-mail">
        {[0, 1, 2].map((i) => (
          <span key={i} className="qs-sv-envelope" style={{ animationDelay: `${i * 0.6}s` }}>
            <Mail size={18} />
          </span>
        ))}
        <div className="qs-sv-inbox">
          <Users size={18} />
        </div>
      </div>
    );
  if (step === 2)
    return (
      <div className="qs-sv qs-sv-shuffle">
        {["A", "B", "C", "D"].map((l, i) => (
          <span key={l} className="qs-sv-card" style={{ animationDelay: `${i * 0.15}s`, ["--c" as any]: COLORS[i] }}>
            {l}
          </span>
        ))}
        <span className="qs-sv-rule">A ⇄ B 🚫</span>
      </div>
    );
  return (
    <div className="qs-sv qs-sv-reveal">
      <div className="qs-sv-flip">
        <span className="front">
          <Gift size={22} />
        </span>
        <span className="back">
          <small>🎁</small>
          <strong>Carla</strong>
        </span>
      </div>
    </div>
  );
}

const STEP_ICONS = [Wand2, Mail, Shuffle, Sparkles];
const EXAMPLES = ["office", "family", "books"] as const;
const PLANS = [
  { key: "free", featured: false },
  { key: "pro", featured: true },
  { key: "enterprise", featured: false },
] as const;

export default function Landing() {
  const { t } = useTranslation();
  const [example, setExample] = useState(0);
  const [faq, setFaq] = useState<number | null>(0);
  useEffect(() => {
    const id = setInterval(() => setExample((e) => (e + 1) % EXAMPLES.length), 5000);
    return () => clearInterval(id);
  }, []);
  const ex = EXAMPLES[example];

  return (
    <div className="qs-landing">
      <header className="qs-landing-nav">
        <Brand />
        <nav>
          <a href="#how" className="qs-nav-anchor">
            {t("landing.nav.how")}
          </a>
          <a href="#pricing" className="qs-nav-anchor">
            {t("landing.nav.pricing")}
          </a>
          <LanguageToggle />
          <Link to="/login" className="qs-btn qs-btn-ghost">
            {t("landing.signIn")}
          </Link>
          <Link to="/start" className="qs-btn qs-btn-primary">
            {t("landing.cta")}
          </Link>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="qs-hero2">
        <div className="qs-snow" aria-hidden />
        <div className="qs-hero2-copy">
          <p className="qs-pill">
            <Sparkles size={14} /> {t("landing.pill")}
          </p>
          <h1>
            {t("landing.title1")} <span className="qs-hero-accent">{t("landing.title2")}</span>
          </h1>
          <p className="qs-hero-sub">{t("landing.subtitle")}</p>
          <div className="qs-hero-actions">
            <Link to="/start" className="qs-btn qs-btn-primary qs-btn-lg">
              {t("landing.cta")} <ArrowRight size={18} />
            </Link>
            <a href="#how" className="qs-btn qs-btn-ghost qs-btn-lg">
              {t("landing.seeHow")}
            </a>
          </div>
          <ul className="qs-hero-proof">
            <li>
              <Check size={15} /> {t("landing.proof.noPasswords")}
            </li>
            <li>
              <Check size={15} /> {t("landing.proof.exclusions")}
            </li>
            <li>
              <Check size={15} /> {t("landing.proof.languages")}
            </li>
          </ul>
        </div>
        <HeroDraw />
      </section>

      {/* ── Services ── */}
      <section className="qs-services">
        <h2>{t("landing.servicesTitle")}</h2>
        <div className="qs-service-grid">
          {SERVICES.map(({ key, icon: Icon }, i) => (
            <Link key={key} to={`/start?type=${key}`} className={`qs-service-card qs-reveal-up${key === "custom" ? " is-custom" : ""}`} style={{ animationDelay: `${i * 0.08}s` }}>
              {!FREE_SERVICES.has(key) ? <span className="qs-pro-tag">Pro</span> : null}
              <span className="qs-service-icon">
                <Icon size={22} />
              </span>
              <strong>{t(`services.${key}.name`)}</strong>
              <span>{t(`services.${key}.desc`)}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="qs-how" id="how">
        <p className="qs-kicker center">{t("landing.how.kicker")}</p>
        <h2>{t("landing.how.title")}</h2>
        <ol className="qs-how-steps">
          {[0, 1, 2, 3].map((i) => {
            const Icon = STEP_ICONS[i];
            return (
              <li key={i} className="qs-how-step qs-reveal-up" style={{ animationDelay: `${i * 0.12}s` }}>
                <StepVisual step={i} />
                <span className="qs-how-num">
                  <Icon size={16} /> {i + 1}
                </span>
                <h3>{t(`landing.how.s${i + 1}.title`)}</h3>
                <p>{t(`landing.how.s${i + 1}.body`)}</p>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── Examples ── */}
      <section className="qs-examples">
        <h2>{t("landing.examples.title")}</h2>
        <div className="qs-example-tabs" role="tablist">
          {EXAMPLES.map((k, i) => (
            <button key={k} role="tab" aria-selected={example === i} className={example === i ? "is-active" : ""} onClick={() => setExample(i)}>
              {t(`landing.examples.${k}.tab`)}
            </button>
          ))}
        </div>
        <div className="qs-example" key={ex}>
          <div className="qs-example-ticket">
            <span className="qs-kicker">{t(`landing.examples.${ex}.service`)}</span>
            <h3>{t(`landing.examples.${ex}.name`)}</h3>
            <ul>
              <li>👥 {t(`landing.examples.${ex}.people`)}</li>
              <li>💸 {t(`landing.examples.${ex}.budget`)}</li>
              <li>🚫 {t(`landing.examples.${ex}.rule`)}</li>
            </ul>
          </div>
          <div className="qs-example-story">
            <p>{t(`landing.examples.${ex}.story`)}</p>
            <Link to="/start" className="qs-btn qs-btn-primary">
              {t("landing.examples.cta")} <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Trust ── */}
      <section className="qs-features">
        {[
          { icon: Shuffle, k: "fair" },
          { icon: Lock, k: "passwordless" },
          { icon: ShieldCheck, k: "private" },
        ].map(({ icon: Icon, k }) => (
          <div key={k} className="qs-feature">
            <Icon size={22} />
            <h3>{t(`landing.features.${k}.title`)}</h3>
            <p>{t(`landing.features.${k}.body`)}</p>
          </div>
        ))}
      </section>

      {/* ── Pricing ── */}
      <section className="qs-pricing" id="pricing">
        <p className="qs-kicker center">{t("landing.pricing.kicker")}</p>
        <h2>{t("landing.pricing.title")}</h2>
        <div className="qs-plans">
          {PLANS.map(({ key, featured }) => (
            <div key={key} className={`qs-plan${featured ? " is-featured" : ""}`}>
              {featured ? <span className="qs-plan-badge">{t("landing.pricing.popular")}</span> : null}
              <h3>{t(`landing.pricing.${key}.name`)}</h3>
              <p className="qs-plan-price">
                <strong>{t(`landing.pricing.${key}.price`)}</strong> <span>{t(`landing.pricing.${key}.per`)}</span>
              </p>
              <p className="qs-fine">{t(`landing.pricing.${key}.desc`)}</p>
              <ul>
                {(t(`landing.pricing.${key}.features`, { returnObjects: true }) as string[]).map((f) => (
                  <li key={f}>
                    <Check size={15} /> {f}
                  </li>
                ))}
              </ul>
              <Link to={key === "enterprise" ? "/login" : "/start"} className={`qs-btn ${featured ? "qs-btn-primary" : "qs-btn-ghost"}`}>
                {t(`landing.pricing.${key}.cta`)}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="qs-faq">
        <h2>{t("landing.faq.title")}</h2>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={`qs-faq-item${faq === i ? " is-open" : ""}`}>
            <button type="button" aria-expanded={faq === i} onClick={() => setFaq(faq === i ? null : i)}>
              {t(`landing.faq.q${i}`)} <ChevronDown size={18} />
            </button>
            <p>{t(`landing.faq.a${i}`)}</p>
          </div>
        ))}
      </section>

      <section className="qs-final-cta">
        <h2>{t("landing.final.title")}</h2>
        <Link to="/start" className="qs-btn qs-btn-primary qs-btn-lg">
          {t("landing.cta")} <ArrowRight size={18} />
        </Link>
      </section>

      <footer className="qs-landing-foot">
        <Brand compact /> <span>© {new Date().getFullYear()} QuickSanta · Disrupting Labs</span>
        <Link to="/privacy">{t("legal.privacy")}</Link>
        <Link to="/terms">{t("legal.terms")}</Link>
      </footer>
    </div>
  );
}
