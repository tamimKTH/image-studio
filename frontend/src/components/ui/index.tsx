// UI primitives shared by every screen. Styles live in ui.module.css.
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { create } from "zustand";
import s from "./ui.module.css";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
export { cx };

// ---------- Button ----------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  loading?: boolean;
  shortcut?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, shortcut, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.button, s[variant], size !== "md" && s[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className={s.spinner} /> : icon}
      {children}
      {shortcut && <span className={s.kbd}>{shortcut}</span>}
    </button>
  );
});

// ---------- IconButton ----------
type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  small?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, small, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(s.iconButton, active && s.active, small && s.iconSm, className)}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------- Chip ----------
type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; icon?: ReactNode };

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected, icon, className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={cx(s.chip, selected && s.selected, className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});

// ---------- Popover ----------
type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  title?: string;
  width?: number;
  children: ReactNode;
}

/** Floating panel anchored to an element. Closes on outside click and Escape; flips when there is no room. */
export function Popover({ anchor, open, onClose, placement = "bottom-start", title, width, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.scrollHeight;
    const gap = 8;
    const margin = 12;
    const below = window.innerHeight - a.bottom - gap - margin;
    const above = a.top - gap - margin;
    // The preferred side when the panel fits there, else the roomier side. It scrolls rather than covering its button.
    const fitsPreferred = placement.startsWith("bottom") ? h <= below : h <= above;
    const useBelow = placement.startsWith("bottom") ? fitsPreferred || below >= above : !(fitsPreferred || above >= below);
    const maxHeight = Math.max(120, Math.min(520, useBelow ? below : above));
    const top = useBelow ? a.bottom + gap : a.top - gap - Math.min(h, maxHeight);
    let left = placement.endsWith("start") ? a.left : a.right - w;
    left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
    setPos({ top, left, maxHeight });
  }, [anchor, placement]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    const onResize = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    const observer = new ResizeObserver(onResize);
    if (ref.current) observer.observe(ref.current);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      observer.disconnect();
    };
  }, [open, onClose, anchor, place]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className={s.popover}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight, width, visibility: pos ? "visible" : "hidden" }}
    >
      {title && <div className={s.popoverTitle}>{title}</div>}
      {children}
    </div>,
    document.body,
  );
}

/** Popover state bound to a trigger element. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const anchor = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { anchor, open, toggle, close, setOpen };
}

// ---------- Menu ----------
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

export function Menu({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <div role="menu">
      {items.map((item) => (
        <div key={item.label}>
          {item.separatorBefore && <div className={s.menuSeparator} />}
          <button
            type="button"
            role="menuitem"
            className={cx(s.menuItem, item.danger && s.dangerItem)}
            onClick={() => {
              onDone();
              item.onSelect();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Modal ----------
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: "normal" | "wide" | "full";
  footer?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}

export function Modal({ open, onClose, title, size = "normal", footer, children, bodyClassName }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea, button:not([data-close])");
    first?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={cx(s.modal, size === "wide" && s.modalWide, size === "full" && s.modalFull)}
      >
        {title !== undefined && (
          <div className={s.modalHeader}>
            <div className={s.modalTitle}>{title}</div>
            <IconButton label="Close" data-close onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}
        <div className={cx(s.modalBody, bodyClassName)}>{children}</div>
        {footer && <div className={s.modalFooter}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toast ----------
interface ToastItem {
  id: number;
  message: string;
  tone: "normal" | "error";
  action?: { label: string; onClick: () => void };
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let toastId = 0;

export function toast(message: string, opts: { action?: ToastItem["action"]; tone?: ToastItem["tone"]; ms?: number } = {}) {
  const id = ++toastId;
  useToasts.setState((st) => ({ items: [...st.items.slice(-2), { id, message, tone: opts.tone ?? "normal", action: opts.action }] }));
  setTimeout(() => dismissToast(id), opts.ms ?? (opts.action ? 6000 : 3500));
  return id;
}

export function dismissToast(id: number) {
  useToasts.setState((st) => ({ items: st.items.filter((t) => t.id !== id) }));
}

export function Toaster() {
  const items = useToasts((st) => st.items);
  return createPortal(
    <div className={s.toaster} aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx(s.toast, t.tone === "error" && s.error)}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className={s.toastAction}
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Segmented ----------
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={cx(s.segment, value === o.value && s.on)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Switch ----------
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx(s.switch, checked && s.on)}
      onClick={() => onChange(!checked)}
    />
  );
}

// ---------- Inputs ----------
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className={s.label}>{label}</span>
      {children}
      {hint && <div className={s.hint}>{hint}</div>}
    </label>
  );
}

export const inputClass = s.input;
export const textareaClass = s.textarea;
export const selectClass = s.select;

// ---------- Spinner / Progress ----------
export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className={s.spinner} aria-label="Loading" />;
}

/** Circular progress. `value` 0–1; undefined spins. */
export function ProgressRing({ value, size = 28, stroke = 3 }: { value?: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const indeterminate = value === undefined;
  const v = indeterminate ? 0.25 : Math.min(1, Math.max(0, value));
  return (
    <svg
      width={size}
      height={size}
      className={cx(s.ring, indeterminate && s.ringIndeterminate)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(v * 100)}
    >
      <circle className={s.ringTrack} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
      <circle
        className={s.ringBar}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
      />
    </svg>
  );
}

// ---------- Empty state ----------
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>{icon}</div>
      <div className={s.emptyTitle}>{title}</div>
      {text && <div className={s.emptyText}>{text}</div>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}
