/**
 * Exchange page → People: the shareable invite link + short code (free on every plan).
 * On/off, copy, WhatsApp / native share, QR (view + download), optional cap + expiry, regenerate.
 * Joiners sign in with email OTP and join instantly; the organizer can remove them before the draw.
 * The link closes automatically at the draw and never exceeds the plan limit (server-enforced).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { Check, Copy, Download, Link2, QrCode, RefreshCw, Share2 } from "lucide-react";
import type { InviteLinkInfo } from "@shared/api";
import { Card, ErrorNote } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/portal/Modal";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchInviteLink, regenerateInviteLink, updateInviteLink } from "@/store/slices/appSlice";

export function shareText(t: (k: string, o?: any) => string, eventName: string, link: InviteLinkInfo) {
  return t("inviteLink.shareText", { event: eventName, url: link.url, code: link.code });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function InviteLinkPanel({ eventId, eventName }: { eventId: number; eventName: string }) {
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const state = useAppSelector((s) => s.app.inviteLink);
  const busy = useAppSelector((s) => Boolean(s.app.loading.inviteLinkBusy));
  const link = state?.eventId === eventId ? state.link : null;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [max, setMax] = useState("");
  const [expires, setExpires] = useState("");

  useEffect(() => {
    void dispatch(fetchInviteLink(eventId));
  }, [eventId, dispatch]);
  useEffect(() => {
    setMax(link?.max != null ? String(link.max) : "");
    setExpires(link?.expires_at ? link.expires_at.slice(0, 10) : "");
  }, [link?.max, link?.expires_at]);
  useEffect(() => {
    if (!qrOpen || !link?.url) return;
    void QRCode.toDataURL(link.url, { margin: 1, width: 640, color: { dark: "#7f1d1d", light: "#ffffff" } }).then(setQr);
  }, [qrOpen, link?.url]);

  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await (p as any).unwrap();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };
  const doCopy = async (what: "link" | "code") => {
    if (!link) return;
    if (await copy(what === "link" ? link.url! : link.code!)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    }
  };
  const nativeShare = async () => {
    if (!link?.url) return;
    try {
      await navigator.share({ title: eventName, text: shareText(t, eventName, link), url: link.url });
    } catch {
      /* dismissed */
    }
  };
  const saveLimits = async () => {
    const n = max.trim() ? Number(max) : null;
    if (n != null && (!Number.isInteger(n) || n < 1 || n > 1000)) return setError("validation.joinMax");
    if (await act(dispatch(updateInviteLink({ eventId, patch: { max: n, expires_at: expires || null } })))) setLimitsOpen(false);
  };

  const on = Boolean(link?.enabled);
  const closed = link?.state === "closed";
  const canShare = on && link?.code && link.state === "active";
  const hasNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <Card className="qs-invite-link" title={t("inviteLink.title")}>
      <div className="qs-invite-link-head">
        <p className="qs-page-sub">{t("inviteLink.sub")}</p>
        <label className="qs-switch">
          <input type="checkbox" checked={on} disabled={busy || !link || (closed && !on)} onChange={(e) => void act(dispatch(updateInviteLink({ eventId, patch: { enabled: e.target.checked } })))} />
          <span>{t("inviteLink.toggle")}</span>
        </label>
      </div>
      <ErrorNote error={error} />

      {link && on && link.code ? (
        <>
          <div className={`qs-invite-code is-${link.state}`}>
            <div>
              <span className="qs-invite-code-label">{t("inviteLink.code")}</span>
              <strong aria-label={t("inviteLink.codeAria", { code: link.code })}>{link.code}</strong>
            </div>
            <span className={`qs-badge qs-badge--${link.state === "active" ? "green" : "gold"}`}>{t(`inviteLink.state.${link.state}`)}</span>
          </div>
          {link.state !== "active" ? <p className="qs-fine qs-warn">{t(`inviteLink.stateHelp.${link.state}`)}</p> : null}

          <div className="qs-invite-url">
            <input readOnly value={link.url ?? ""} aria-label={t("inviteLink.url")} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void doCopy("link")}>
              {copied === "link" ? <Check /> : <Copy />} {copied === "link" ? t("inviteLink.copied") : t("inviteLink.copyLink")}
            </Button>
          </div>

          <div className="qs-invite-actions">
            {canShare ? (
              <a className="qs-btn qs-btn-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(shareText(t, eventName, link))}`} target="_blank" rel="noreferrer">
                <Share2 size={16} /> {t("inviteLink.whatsapp")}
              </a>
            ) : (
              <button type="button" className="qs-btn qs-btn-whatsapp" disabled>
                <Share2 size={16} /> {t("inviteLink.whatsapp")}
              </button>
            )}
            {hasNativeShare ? (
              <Button type="button" variant="outline" disabled={!canShare} onClick={() => void nativeShare()}>
                <Share2 /> {t("inviteLink.share")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setQrOpen(true)}>
              <QrCode /> {t("inviteLink.qr")}
            </Button>
            <Button type="button" variant="outline" onClick={() => void doCopy("code")}>
              {copied === "code" ? <Check /> : <Copy />} {copied === "code" ? t("inviteLink.copied") : t("inviteLink.copyCode")}
            </Button>
          </div>

          <p className="qs-invite-stats">
            <Link2 size={14} /> {t("inviteLink.stats", { count: link.joined_via_link, seats: link.seats_left })}
            {link.max != null ? <span> · {t("inviteLink.capInfo", { max: link.max })}</span> : null}
            {link.expires_at ? <span> · {t("inviteLink.expiresInfo", { date: new Date(`${link.expires_at.replace(" ", "T")}Z`).toLocaleDateString(i18n.language) })}</span> : null}
          </p>

          <div className="qs-invite-foot">
            <button type="button" className="qs-link-btn" onClick={() => setLimitsOpen((v) => !v)} aria-expanded={limitsOpen}>
              {t("inviteLink.limits")}
            </button>
            {confirmRegen ? (
              <span className="qs-row">
                <button type="button" className="qs-btn qs-btn-danger" disabled={busy} onClick={() => void act(dispatch(regenerateInviteLink(eventId))).then(() => setConfirmRegen(false))}>
                  <RefreshCw size={15} /> {t("inviteLink.regenConfirm")}
                </button>
                <button type="button" className="qs-link-btn" onClick={() => setConfirmRegen(false)}>
                  {t("common.cancel")}
                </button>
              </span>
            ) : (
              <button type="button" className="qs-link-btn" onClick={() => setConfirmRegen(true)}>
                <RefreshCw size={14} /> {t("inviteLink.regen")}
              </button>
            )}
          </div>
          {confirmRegen ? <p className="qs-fine">{t("inviteLink.regenHelp")}</p> : null}

          {limitsOpen ? (
            <div className="qs-invite-limits">
              <label className="qs-field">
                <span>{t("inviteLink.max")}</span>
                <input type="number" inputMode="numeric" min={1} max={1000} value={max} placeholder={t("inviteLink.maxPh")} onChange={(e) => setMax(e.target.value)} />
              </label>
              <label className="qs-field">
                <span>{t("inviteLink.expires")}</span>
                <input type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
              </label>
              <p className="qs-fine">{t("inviteLink.limitsHelp")}</p>
              <Button type="button" className="qs-btn-primary" disabled={busy} onClick={() => void saveLimits()}>
                {t("common.save")}
              </Button>
            </div>
          ) : null}
        </>
      ) : link && closed ? (
        <p className="qs-fine">{t("inviteLink.stateHelp.closed")}</p>
      ) : (
        <p className="qs-fine">{t("inviteLink.offHelp")}</p>
      )}

      <Modal open={qrOpen} titleKey="inviteLink.qrTitle" onClose={() => setQrOpen(false)}>
        <div className="qs-invite-qr">
          {qr ? <img src={qr} alt={t("inviteLink.qrAlt", { event: eventName })} width={280} height={280} /> : null}
          <strong>{link?.code}</strong>
          <p className="qs-fine">{t("inviteLink.qrHelp")}</p>
          {qr ? (
            <a className="qs-btn qs-btn-primary" href={qr} download={`quicksanta-${(link?.code ?? "invite").toLowerCase()}.png`}>
              <Download size={16} /> {t("inviteLink.qrDownload")}
            </a>
          ) : null}
        </div>
      </Modal>
    </Card>
  );
}
