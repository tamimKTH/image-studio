import type { ReactNode } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import type { NodeStatus } from "../../lib/api";
import { ProgressRing, cx } from "../ui";
import s from "./media.module.css";

interface Props {
  /** Finished image (thumbnail URL). */
  src?: string;
  /** Live preview while generating (data URL). */
  preview?: string;
  state: NodeStatus;
  step?: number;
  steps?: number;
  error?: string | null;
  /** Width / height, for the placeholder before an image exists. */
  ratio?: number;
  onClick?: () => void;
  /** Hover actions for a finished image; use <CardAction>. */
  actions?: ReactNode;
  caption?: ReactNode;
  alt?: string;
}

/** One image slot: queued → forming live with step count → finished image with hover actions. */
export function ImageCard({ src, preview, state, step = 0, steps = 0, error, ratio = 1, onClick, actions, caption, alt = "" }: Props) {
  const running = state === "running";
  const waiting = state === "queued" || state === "waiting";
  const shown = src ?? preview;
  return (
    <div className={cx(s.card, onClick && src && s.clickable)}>
      <div
        className="checker"
        style={{ aspectRatio: String(ratio), position: "relative" }}
        onClick={src ? onClick : undefined}
        role={onClick && src ? "button" : undefined}
        tabIndex={onClick && src ? 0 : undefined}
        onKeyDown={(e) => e.key === "Enter" && src && onClick?.()}
      >
        {shown && <img src={shown} alt={alt} className={cx(!src && s.preview)} draggable={false} />}
        {(running || waiting) && !preview && <div className={s.shimmer} />}
        {waiting && (
          <div className={s.placeholder}>
            <Clock size={20} />
            {state === "waiting" ? "Waiting for inputs" : "In queue"}
          </div>
        )}
        {running && !preview && (
          <div className={s.placeholder}>
            <ProgressRing size={30} />
            {steps ? "Starting…" : "Loading the model…"}
          </div>
        )}
        {running && (
          <div className={s.status}>
            <ProgressRing size={18} stroke={2.5} value={steps ? step / steps : undefined} />
            {steps ? `Step ${step} of ${steps}` : "Preparing"}
          </div>
        )}
        {(state === "failed" || state === "skipped" || state === "canceled") && !src && (
          <div className={cx(s.placeholder, state === "failed" && s.failed)}>
            <AlertTriangle size={20} />
            {state === "failed" ? error || "Failed" : state === "skipped" ? "Skipped — an input failed" : "Canceled"}
          </div>
        )}
        {src && actions && <div className={s.actions}>{actions}</div>}
      </div>
      {caption && <div className={s.caption}>{caption}</div>}
    </div>
  );
}

export function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={s.action}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
