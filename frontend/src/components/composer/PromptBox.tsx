import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, type Aspect } from "../../lib/api";
import { useLive } from "../../lib/events";
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
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
  /** Called with the suggested aspect ("auto" means follow image 1). */
  onAspect?: (aspect: Aspect) => void;
  onBusyChange?: (busy: boolean) => void;
  size?: "sm" | "md";
}

/** ✨ Improve: rewrites the prompt with the model's own prompt enhancer. Click again to stop. */
export function ImproveButton({ prompt, images, onChange, onAspect, onBusyChange, size = "sm" }: ImproveProps) {
  const [busy, setBusy] = useState(false);
  // The improver shares the engine: if an image is being made, it starts right after that one.
  const [waiting, setWaiting] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  async function run() {
    if (busy) {
      abort.current?.abort();
      return;
    }
    const previous = prompt;
    abort.current = new AbortController();
    setWaiting((useLive.getState().engine?.queue ?? 0) > 0);
    setBusy(true);
    try {
      const r = await api.enhance(prompt, images, abort.current.signal);
      onChange(r.prompt);
      if (r.matchImage) onAspect?.("auto");
      else if (r.aspect) onAspect?.(r.aspect);
      toast(r.aspect && !r.matchImage ? `Prompt improved · aspect set to ${r.aspect}` : "Prompt improved", {
        action: { label: "Undo", onClick: () => onChange(previous) },
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size={size}
      variant="ghost"
      className={cx(s.improve, busy && s.improving)}
      icon={<Sparkles size={15} />}
      loading={false}
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
  );
}
