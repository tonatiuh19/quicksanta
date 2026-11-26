import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CalendarDays, Gift, Lock, MapPin, Sparkles, Wallet } from "lucide-react";
import { Card, ErrorNote, PageHeader, Spinner, StatusBadge, formatBudget, formatDate } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchMyAssignment, saveWishlist } from "@/store/slices/appSlice";

export default function MyAssignment() {
  const { publicId = "" } = useParams();
  const { t, i18n } = useTranslation();
  const dispatch = useAppDispatch();
  const { my, loading, error } = useAppSelector((s) => s.app);
  const [revealed, setRevealed] = useState(false);
  const [wish, setWish] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void dispatch(fetchMyAssignment(publicId));
  }, [dispatch, publicId]);
  useEffect(() => {
    if (my?.event.public_id === publicId) setWish(my.me.wishlist ?? "");
  }, [my, publicId]);

  if (!my || my.event.public_id !== publicId) return <div className="portal-page">{loading.my ? <Spinner label={t("common.loading")} /> : <ErrorNote error={error} />}</div>;
  const { event, receiver } = my;

  return (
    <div className="portal-page">
      <Link to="/app/my" className="qs-back">
        <ArrowLeft size={15} /> {t("nav.myExchanges")}
      </Link>
      <PageHeader
        kicker={t(`services.${event.event_type_slug}.name`, { defaultValue: event.event_type_name })}
        title={
          <>
            {event.name} <StatusBadge value={event.status} />
          </>
        }
      />
      <div className="qs-invite-meta qs-mb">
        <span>
          <CalendarDays size={15} /> {formatDate(event.exchange_date, i18n.language)}
        </span>
        <span>
          <Wallet size={15} /> {formatBudget(event.budget_min, event.budget_max, event.currency)}
        </span>
        {event.location ? (
          <span>
            <MapPin size={15} /> {event.location}
          </span>
        ) : null}
      </div>

      <div className="qs-two-col">
        <div className={`qs-reveal${revealed ? " is-revealed" : ""}`}>
          {receiver ? (
            <button type="button" className="qs-reveal-inner" onClick={() => setRevealed(true)} aria-label={t("my.reveal")}>
              <span className="qs-reveal-front">
                <Gift size={40} />
                <strong>{t("my.tapToReveal")}</strong>
                <span>{t("my.secret")}</span>
              </span>
              <span className="qs-reveal-back">
                <Sparkles size={22} />
                <span className="qs-kicker">{t("my.youGift")}</span>
                <strong className="qs-reveal-name">{receiver.name}</strong>
                {receiver.wishlist ? (
                  <span className="qs-reveal-wish">
                    <em>{t("my.theirWishlist")}</em>
                    {receiver.wishlist}
                  </span>
                ) : (
                  <span className="qs-fine">{t("my.noWishlist")}</span>
                )}
              </span>
            </button>
          ) : (
            <div className="qs-reveal-waiting">
              <Lock size={32} />
              <strong>{t("my.waiting")}</strong>
              <span>{t("my.waitingBody")}</span>
            </div>
          )}
        </div>

        {event.allow_wishlists ? (
          <Card title={t("my.myWishlist")}>
            <p className="qs-fine">{t("my.wishlistHint")}</p>
            <textarea className="qs-textarea" rows={6} maxLength={4000} value={wish} onChange={(e) => (setWish(e.target.value), setSaved(false))} aria-label={t("my.myWishlist")} placeholder={t("my.wishlistPh")} />
            <div className="qs-row">
              <Button
                className="qs-btn-primary"
                disabled={loading.busy || event.status === "completed" || event.status === "cancelled"}
                onClick={() => void dispatch(saveWishlist({ publicId, wishlist: wish })).then((r) => setSaved(saveWishlist.fulfilled.match(r)))}
              >
                {t("common.save")}
              </Button>
              {saved ? <span className="qs-fine">✓ {t("common.saved")}</span> : null}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
