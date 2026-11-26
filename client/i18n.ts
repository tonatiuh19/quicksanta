import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en/translation.json";
import es from "./locales/es/translation.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, es: { translation: es } },
    fallbackLng: "en",
    supportedLngs: ["en", "es"],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: { order: ["localStorage", "navigator"], caches: ["localStorage"], lookupLocalStorage: "qs_lang" },
    // Tests render in English regardless of the machine locale.
    lng: import.meta.env?.MODE === "test" ? "en" : undefined,
  });

export default i18n;

// Keep <html lang> in sync (screen readers + number/date formatting helpers read it).
const syncLang = (lng: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = lng?.startsWith("es") ? "es" : "en";
};
syncLang(i18n.language);
i18n.on("languageChanged", syncLang);
