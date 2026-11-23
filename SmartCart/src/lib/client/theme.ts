export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'smartcart-theme';

/** The theme on screen: the visitor's choice, or the OS setting. */
export function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Show and remember a theme. Storage can be unavailable (private mode); the choice still applies. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this visit.
  }
}
