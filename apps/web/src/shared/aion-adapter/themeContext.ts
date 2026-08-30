export function useThemeContext() {
  return { theme: document.documentElement.classList.contains("dark") ? "dark" : "light" };
}
