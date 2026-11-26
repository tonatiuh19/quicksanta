import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";

export default function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const es = i18n.language?.startsWith("es");
  return (
    <button type="button" className="qs-lang" onClick={() => void i18n.changeLanguage(es ? "en" : "es")} aria-label={t("common.language")}>
      <Languages size={15} aria-hidden /> {es ? "EN" : "ES"}
    </button>
  );
}
