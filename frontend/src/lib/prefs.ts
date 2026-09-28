// Small per-browser preferences. Storage can be unavailable, so every access is guarded.
import { useEffect, useState } from "react";

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
  window.dispatchEvent(new Event("studio-theme"));
}

function resolvedTheme(): "light" | "dark" {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme actually shown ("system" resolved), kept in sync with the switch and the OS setting. */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    const update = () => setTheme(resolvedTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    window.addEventListener("studio-theme", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("studio-theme", update);
    };
  }, []);
  return theme;
}
