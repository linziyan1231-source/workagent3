import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enUS from "@renderer/services/i18n/locales/en-US";
import zhCN from "@renderer/services/i18n/locales/zh-CN";

function applyPuxinBrand<T>(resource: T): T {
  return JSON.parse(
    JSON.stringify(resource)
      .replaceAll("CLIENTNAME", "Puxin AI")
      .replaceAll("AionUi", "Puxin AI")
      .replaceAll("AionUI", "Puxin AI"),
  ) as T;
}

const savedLanguage =
  typeof localStorage?.getItem === "function"
    ? localStorage.getItem("i18nextLng")
    : null;
const language =
  savedLanguage ??
  (navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");

void i18n.use(initReactI18next).init({
  resources: {
    "en-US": { translation: applyPuxinBrand(enUS) },
    "zh-CN": { translation: applyPuxinBrand(zhCN) },
  },
  lng: language,
  fallbackLng: "en-US",
  interpolation: { escapeValue: false },
});

export { i18n };
