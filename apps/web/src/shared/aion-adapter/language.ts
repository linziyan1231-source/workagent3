import { i18n } from "../ui/aionui/i18n";
export function changeLanguage(language: string) {
  localStorage.setItem("i18nextLng", language);
  return i18n.changeLanguage(language);
}
