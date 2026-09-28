// Small per-browser preferences. Storage can be unavailable, so every access is guarded.

export type Theme = "system" | "light" | "dark";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`studio.${key}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`studio.${key}`, JSON.stringify(value));
  } catch {
    /* not persisted */
  }
}

export function loadTheme(): Theme {
  return load<{ theme: Theme }>("theme", { theme: "system" }).theme;
}

export function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  save("theme", { theme });
}
