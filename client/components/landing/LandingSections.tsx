/**
 * Home-page sections for the newer features:
 *  - JoinCodeStrip: "Have a code?" → /j/:code (invitees land on the home page too)
 *  - InviteShowcase: invite link / code / QR (free on every plan), animated phone
 *  - CustomShowcase: "Create your own" live mini-designer (Pro)
 *  - EnterpriseContact: contact-sales modal → POST /api/contact (Command Center → Leads)
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, KeyRound, Link2, QrCode, Send, ShieldCheck, Shuffle, Sparkles, Timer, Users, UserPlus } from "lucide-react";
import type { CustomColor, CustomIcon, TeamSize } from "@shared/api";
import { EMAIL_RE, normalizeEmail } from "@shared/api";
import { ErrorNote } from "@/components/kit";
import { Modal } from "@/components/portal/Modal";
import { Button } from "@/components/ui/button";
import { CUSTOM_ICON_MAP, gradientFor } from "@/components/customDesign";
import { formatCodeInput, isCompleteCode } from "@/lib/joinCode";
import { useAppDispatch } from "@/store/hooks";
import { submitContact } from "@/store/slices/appSlice";

/* ─────────────── Have a code? ─────────────── */
export function JoinCodeStrip() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (!isCompleteCode(code)) return setErr("joinCode.errors.format");
    navigate(`/j/${code}`);
  };
  return (
    <section className="qs-code-strip" id="join" aria-labelledby="code-strip-title">
      <div className="qs-code-strip-copy">
        <span className="qs-code-strip-icon" aria-hidden>
          <KeyRound size={20} />
        </span>
        <div>
          <h2 id="code-strip-title">{t("landing.codeStrip.title")}</h2>
          <p>{t("landing.codeStrip.body")}</p>
        </div>
      </div>
      <form className="qs-code-strip-form" onSubmit={go} noValidate>
        <input
          className="qs-code-input"
          aria-label={t("joinCode.codeLabel")}
          placeholder="7K4P-QX9M"
          value={code}
          onChange={(e) => (setCode(formatCodeInput(e.target.value)), setErr(null))}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={9}
        />
        <Button type="submit" className="qs-btn-primary">
          {t("landing.codeStrip.go")} <ArrowRight />
        </Button>
        <ErrorNote error={err} />
      </form>
    </section>
  );
}

/* ─────────────── Invite link showcase ─────────────── */
const JOINERS = ["Ana", "Bruno", "Carla", "Diego", "Elena"];
const JOINER_COLORS = ["#dc2626", "#d6a23a", "#16a34a", "#2563eb", "#9333ea"];

/** Loops: code ticket → WhatsApp message → people pop in. Pure decoration (aria-hidden). */
function InvitePhone() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % 3), 3200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={`qs-phone is-phase-${phase}`} aria-hidden>
      <div className="qs-phone-notch" />
      <div className="qs-phone-screen">
        {phase === 0 ? (
          <div className="qs-phone-stage" key="code">
            <div className="qs-phone-ticket">
              <small>{t("landing.invite.demo.code")}</small>
              <strong>7K4P-QX9M</strong>
            </div>
            <div className="qs-phone-qr">
              <QrCode size={64} strokeWidth={1.4} />
            </div>
            <span className="qs-phone-chip">
              <Link2 size={12} /> quicksanta.com/j/7K4P-QX9M
            </span>
          </div>
        ) : phase === 1 ? (
          <div className="qs-phone-stage qs-phone-chat" key="chat">
            <span className="qs-phone-chat-head">{t("landing.invite.demo.group")}</span>
            <p className="qs-bubble is-me">{t("landing.invite.demo.message")}</p>
            <p className="qs-bubble">{t("landing.invite.demo.reply1")}</p>
            <p className="qs-bubble">{t("landing.invite.demo.reply2")}</p>
          </div>
        ) : (
          <div className="qs-phone-stage" key="people">
            <span className="qs-phone-chat-head">{t("landing.invite.demo.joined")}</span>
            <ul className="qs-phone-people">
              {JOINERS.map((n, i) => (
                <li key={n} style={{ animationDelay: `${i * 0.35}s`, ["--c" as string]: JOINER_COLORS[i] }}>
                  <span className="qs-phone-avatar">{n[0]}</span>
                  {n}
                  <em>{t("landing.invite.demo.viaLink")}</em>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function InviteShowcase() {
  const { t } = useTranslation();
  const points = [
    { icon: QrCode, k: "share" },
    { icon: UserPlus, k: "join" },
    { icon: ShieldCheck, k: "control" },
    { icon: Timer, k: "closes" },
  ];
  return (
    <section className="qs-showcase" id="invite-link">
      <div className="qs-showcase-copy">
        <p className="qs-kicker">
          <Sparkles size={13} /> {t("landing.invite.kicker")}
        </p>
        <h2>{t("landing.invite.title")}</h2>
        <p className="qs-showcase-lead">{t("landing.invite.lead")}</p>
        <ul className="qs-showcase-points">
          {points.map(({ icon: Icon, k }) => (
            <li key={k}>
              <span aria-hidden>
                <Icon size={18} />
              </span>
              <div>
                <strong>{t(`landing.invite.points.${k}.title`)}</strong>
                <p>{t(`landing.invite.points.${k}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
        <Link to="/start" className="qs-btn qs-btn-primary">
          {t("landing.invite.cta")} <ArrowRight size={16} />
        </Link>
      </div>
      <InvitePhone />
    </section>
  );
}

/* ─────────────── Create your own showcase ─────────────── */
const DEMO_ICONS: CustomIcon[] = ["sparkles", "tree", "coffee", "palette", "music", "heart"];
const DEMO_COLORS: CustomColor[] = ["red", "green", "gold", "blue", "purple", "teal"];
const DEMO_NAMES = ["uglySweater", "plants", "recipes"] as const;

export function CustomShowcase() {
  const { t } = useTranslation();
  const [icon, setIcon] = useState<CustomIcon>("tree");
  const [color, setColor] = useState<CustomColor>("green");
  const [draw, setDraw] = useState(true);
  const [nameIdx, setNameIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNameIdx((n) => (n + 1) % DEMO_NAMES.length), 4200);
    return () => clearInterval(id);
  }, []);
  const Icon = CUSTOM_ICON_MAP[icon] ?? Sparkles;
  const name = DEMO_NAMES[nameIdx];
  return (
    <section className="qs-showcase is-reverse" id="create-your-own">
      <div className="qs-designer">
        <div className="qs-designer-ticket" style={{ background: gradientFor(color) }}>
          <span className="qs-designer-icon">
            <Icon size={26} />
          </span>
          <span className="qs-designer-kind">{t("landing.custom.kind")}</span>
          <strong key={name} className="qs-designer-name">
            {t(`landing.custom.names.${name}.title`)}
          </strong>
          <span className="qs-designer-rule">“{t(`landing.custom.names.${name}.rule`)}”</span>
          <span className="qs-designer-mode">
            {draw ? <Shuffle size={13} /> : <Users size={13} />} {t(draw ? "landing.custom.modeDraw" : "landing.custom.modeOpen")}
          </span>
        </div>
        <div className="qs-designer-controls">
          <div role="radiogroup" aria-label={t("landing.custom.iconLabel")} className="qs-designer-row">
            {DEMO_ICONS.map((k) => {
              const I = CUSTOM_ICON_MAP[k];
              return (
                <button key={k} type="button" role="radio" aria-checked={icon === k} aria-label={t(`landing.custom.icons.${k}`)} className={icon === k ? "is-on" : ""} onClick={() => setIcon(k)}>
                  <I size={18} />
                </button>
              );
            })}
          </div>
          <div role="radiogroup" aria-label={t("landing.custom.colorLabel")} className="qs-designer-row">
            {DEMO_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={t(`wizard.design.colors.${c}`)} className={`qs-swatch${color === c ? " is-on" : ""}`} style={{ background: gradientFor(c) }} onClick={() => setColor(c)} />
            ))}
          </div>
          <label className="qs-switch">
            <input type="checkbox" checked={draw} onChange={(e) => setDraw(e.target.checked)} />
            <span>{t("landing.custom.drawToggle")}</span>
          </label>
        </div>
      </div>
      <div className="qs-showcase-copy">
        <p className="qs-kicker">
          <Sparkles size={13} /> {t("landing.custom.kicker")} <span className="qs-pro-tag is-inline">Pro</span>
        </p>
        <h2>{t("landing.custom.title")}</h2>
        <p className="qs-showcase-lead">{t("landing.custom.lead")}</p>
        <ul className="qs-check-list">
          {(t("landing.custom.bullets", { returnObjects: true }) as string[]).map((b) => (
            <li key={b}>
              <Check size={15} /> {b}
            </li>
          ))}
        </ul>
        <Link to="/start?type=custom" className="qs-btn qs-btn-primary">
          {t("landing.custom.cta")} <ArrowRight size={16} />
        </Link>
      </div>
    </section>
  );
}

/* ─────────────── Enterprise contact ─────────────── */
const SIZES: TeamSize[] = ["lt50", "50_100", "100_500", "500_plus"];

export function EnterpriseContact({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const empty = { name: "", email: "", company: "", team_size: "" as TeamSize | "", message: "", website: "" };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => (setF((x) => ({ ...x, [k]: e.target.value })), setError(null));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.name.trim().length < 2) return setError("contact.errors.name");
    if (!EMAIL_RE.test(normalizeEmail(f.email))) return setError("validation.email");
    if (!f.team_size) return setError("contact.errors.size");
    setBusy(true);
    try {
      await dispatch(submitContact({ ...f, email: normalizeEmail(f.email), team_size: f.team_size as TeamSize })).unwrap();
      setSent(true);
      setF(empty);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    onClose();
    setTimeout(() => (setSent(false), setError(null)), 200);
  };

  return (
    <Modal open={open} titleKey="contact.title" onClose={close} initialFocusRef={nameRef}>
      {sent ? (
        <div className="qs-contact-done" role="status">
          <span aria-hidden>
            <Check size={28} />
          </span>
          <h3>{t("contact.doneTitle")}</h3>
          <p>{t("contact.doneBody")}</p>
          <Button className="qs-btn-primary" onClick={close}>
            {t("common.close")}
          </Button>
        </div>
      ) : (
        <form className="qs-form qs-contact-form" onSubmit={submit} noValidate>
          <p className="qs-fine">{t("contact.sub")}</p>
          <label className="qs-field">
            <span>{t("contact.name")}</span>
            <input ref={nameRef} value={f.name} onChange={set("name")} autoComplete="name" maxLength={120} />
          </label>
          <label className="qs-field">
            <span>{t("contact.email")}</span>
            <input type="email" inputMode="email" value={f.email} onChange={set("email")} autoComplete="email" maxLength={190} />
          </label>
          <label className="qs-field">
            <span>{t("contact.company")}</span>
            <input value={f.company} onChange={set("company")} autoComplete="organization" maxLength={160} />
          </label>
          <label className="qs-field">
            <span>{t("contact.size")}</span>
            <select value={f.team_size} onChange={set("team_size")}>
              <option value="">{t("contact.sizePh")}</option>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {t(`contact.sizes.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="qs-field">
            <span>{t("contact.message")}</span>
            <textarea rows={4} value={f.message} onChange={set("message")} maxLength={2000} placeholder={t("contact.messagePh")} />
          </label>
          {/* Honeypot: invisible to people, irresistible to bots. */}
          <label className="qs-hp" aria-hidden>
            Website
            <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
          </label>
          <ErrorNote error={error} />
          <Button type="submit" className="w-full qs-btn-primary" disabled={busy}>
            <Send /> {busy ? t("contact.sending") : t("contact.send")}
          </Button>
          <p className="qs-fine">
            {t("contact.privacy")} <Link to="/privacy">{t("legal.privacy")}</Link>
          </p>
        </form>
      )}
    </Modal>
  );
}
