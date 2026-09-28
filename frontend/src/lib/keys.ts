// Keyboard shortcuts that work the same with ⌘ on a Mac and Ctrl on Windows/Linux keyboards.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True when the primary modifier is held: ⌘ or Ctrl (both are accepted everywhere). */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/** Label for a shortcut with the primary modifier, e.g. "⌘↵" on a Mac and "Ctrl+Enter" elsewhere. */
export function shortcut(key: "Enter" | string): string {
  if (isMac) return `⌘${key === "Enter" ? "↵" : key.toUpperCase()}`;
  return `Ctrl+${key === "Enter" ? "Enter" : key.toUpperCase()}`;
}

/** True when the key event comes from a text field, where editing shortcuts belong to the field. */
export function inTextField(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
