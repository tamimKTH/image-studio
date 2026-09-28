// Tiny menu shown where a dragged connection was dropped on empty canvas.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Scissors, Sparkles } from "lucide-react";
import type { NodeType } from "../lib/api";
import { Menu, type MenuItem } from "../components/ui";
import s from "./flow.module.css";

export interface DropMenuState {
  x: number;
  y: number;
  /** The node the connection was dragged from. */
  nodeId: string;
  /** "source" = dragged out of an output (add a node after it); "target" = out of an input (add one before it). */
  handle: "source" | "target";
}

export function DropMenu({ state, onPick, onClose }: { state: DropMenuState; onPick: (type: NodeType) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items: MenuItem[] =
    state.handle === "source"
      ? [
          { label: "Generate", icon: <Sparkles size={16} />, onSelect: () => onPick("generate") },
          { label: "Remove background", icon: <Scissors size={16} />, onSelect: () => onPick("removeBackground") },
        ]
      : [
          { label: "Image", icon: <ImagePlus size={16} />, onSelect: () => onPick("image") },
          { label: "Generate", icon: <Sparkles size={16} />, onSelect: () => onPick("generate") },
        ];

  const left = Math.min(state.x + 8, window.innerWidth - 220);
  const top = Math.min(state.y + 8, window.innerHeight - 140);
  return createPortal(
    <div ref={ref} className={s.dropMenu} style={{ left, top }} role="dialog" aria-label="Add a node">
      <div className={s.dropMenuTitle}>{state.handle === "source" ? "Add next" : "Add input"}</div>
      <Menu items={items} onDone={onClose} />
    </div>,
    document.body,
  );
}
