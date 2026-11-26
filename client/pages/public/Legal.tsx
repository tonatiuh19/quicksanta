/** /privacy and /terms: Markdown documents (client/content/legal/*.{en,es}.md) in the public chrome. */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import { Brand } from "@/components/kit";
import LanguageToggle from "@/components/LanguageToggle";
import privacyEn from "@/content/legal/privacy.en.md?raw";
import privacyEs from "@/content/legal/privacy.es.md?raw";
import termsEn from "@/content/legal/terms.en.md?raw";
import termsEs from "@/content/legal/terms.es.md?raw";

const DOCS = { privacy: { en: privacyEn, es: privacyEs }, terms: { en: termsEn, es: termsEs } };

export default function Legal({ doc }: { doc: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const md = DOCS[doc][i18n.language?.startsWith("es") ? "es" : "en"];
  return (
    <div className="qs-landing">
      <header className="qs-landing-nav">
        <Link to="/" aria-label="QuickSanta">
          <Brand />
        </Link>
        <nav>
          <LanguageToggle />
          <Link to="/start" className="qs-btn qs-btn-primary">
            {t("landing.cta")}
          </Link>
        </nav>
      </header>
      <article className="qs-legal">
        <Markdown
          components={{
            a: ({ href, children }) =>
              href?.startsWith("/") ? <Link to={href}>{children}</Link> : <a href={href} target={href?.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer">{children}</a>,
            table: ({ children }) => (
              <div className="table-scroll">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {md}
        </Markdown>
      </article>
      <LegalFooter />
    </div>
  );
}

export function LegalFooter() {
  const { t } = useTranslation();
  return (
    <footer className="qs-landing-foot">
      <Brand compact /> <span>© {new Date().getFullYear()} QuickSanta · Disrupting Labs</span>
      <Link to="/privacy">{t("legal.privacy")}</Link>
      <Link to="/terms">{t("legal.terms")}</Link>
    </footer>
  );
}
