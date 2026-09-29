import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles, Undo2 } from "lucide-react";
import { api, type Aspect } from "../../lib/api";
import { useLive } from "../../lib/events";
import { isMod } from "../../lib/keys";
import { Button, cx, toast } from "../ui";
import s from "./composer.module.css";

interface PromptBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  readOnly?: boolean;
  autoFocus?: boolean;
  minHeight?: number;
}

/** Auto-growing prompt field. ⌘↵ / Ctrl+↵ submits. */
export function PromptBox({ value, onChange, placeholder, onSubmit, readOnly, autoFocus, minHeight }: PromptBoxProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={s.prompt}
      style={minHeight ? { minHeight } : undefined}
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      autoFocus={autoFocus}
      rows={2}
      aria-label="Prompt"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && isMod(e)) {
          e.preventDefault();
          onSubmit?.();
        }
      }}
    />
  );
}

interface ImproveProps {
  prompt: string;
  images: string[];
  onChange: (prompt: string) => void;
  /** The aspect in use now, so undoing an improvement also puts back the aspect it replaced. */
  aspect?: Aspect;
  /** Called with the suggested aspect ("auto" means follow image 1). */
  onAspect?: (aspect: Aspect) => void;
  onBusyChange?: (busy: boolean) => void;
  size?: "sm" | "md";
  /** Changing this hides "Undo improve" (e.g. after the prompt was used to generate). */
  resetKey?: unknown;
}

/**
 * ✨ Improve: rewrites the prompt with the model's own prompt enhancer. Click again to stop.
 * Afterwards "Undo improve" stays until the prompt is edited, improved again or `resetKey` changes.
 */
export function ImproveButton({ prompt, images, onChange, aspect, onAspect, onBusyChange, size = "sm", resetKey }: ImproveProps) {
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ original: string; improved: string; aspect?: Aspect } | null>(null);
  // The improver shares the engine: with other work in the queue it starts right after the current image.
  const queue = useLive((st) => st.engine?.queue ?? 0);
  const waiting = busy && queue > 1;
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  useEffect(() => setUndo(null), [resetKey]);
  const canUndo = !busy && undo !== null && prompt === undo.improved;

  function restore(before: { original: string; aspect?: Aspect }) {
    onChange(before.original);
    if (before.aspect) onAspect?.(before.aspect);
    setUndo(null);
  }

  async function run() {
    if (busy) {
      abort.current?.abort();
      return;
    }
    const previous = { original: prompt, aspect };
    abort.current = new AbortController();
    setUndo(null);
    setBusy(true);
    try {
      const r = await api.enhance(prompt, images, abort.current.signal);
      onChange(r.prompt);
      setUndo({ ...previous, improved: r.prompt });
      if (r.matchImage) onAspect?.("auto");
      else if (r.aspect) onAspect?.(r.aspect);
      toast(r.aspect && !r.matchImage ? `Prompt improved · aspect set to ${r.aspect}` : "Prompt improved", {
        action: { label: "Undo", onClick: () => restore(previous) },
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={s.improveGroup}>
      <Button
        size={size}
        variant="ghost"
        className={cx(s.improve, busy && s.improving)}
        icon={<Sparkles size={15} />}
        disabled={!prompt.trim() && !busy}
        onClick={run}
        title={
          busy
            ? waiting
              ? "Starts right after the image being made now — click to stop"
              : "Stop improving"
            : "Rewrite the prompt in rich detail with the model's prompt improver"
        }
      >
        {busy ? (waiting ? "After current image… (stop)" : "Improving… (stop)") : "Improve"}
      </Button>
      {canUndo && (
        <Button
          size={size}
          variant="ghost"
          icon={<Undo2 size={15} />}
          title="Put back the prompt you wrote (and its aspect)"
          onClick={() => restore(undo)}
        >
          Undo improve
        </Button>
      )}
    </span>
  );
}
