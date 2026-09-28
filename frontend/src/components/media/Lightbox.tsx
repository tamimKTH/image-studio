import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import { api, type FileInfo } from "../../lib/api";
import { shortPath, timeAgo } from "../../lib/format";
import { Button, IconButton, toast } from "../ui";
import s from "./media.module.css";

export interface LightboxItem {
  url: string;
  path: string;
  name: string;
  /** The input image, for a before/after slider. */
  compareUrl?: string | null;
}

interface Props {
  items: LightboxItem[];
  index: number | null;
  onIndex: (index: number | null) => void;
  /** Extra buttons for the current image (Use as input, Trash, …). */
  actions?: (item: LightboxItem, info: FileInfo | null) => ReactNode;
}

/** Full-screen view of one image with its prompt and settings, arrows to move through the set. */
export function Lightbox({ items, index, onIndex, actions }: Props) {
  const item = index !== null ? items[index] : undefined;
  const [info, setInfo] = useState<FileInfo | null>(null);
  const path = item?.path;

  useEffect(() => {
    setInfo(null);
    if (path) api.fileInfo(path).then(setInfo).catch(() => setInfo(null));
  }, [path]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onIndex(null);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex]);

  if (!item || index === null) return null;
  const meta = info?.meta;
  const facts: [string, string][] = [];
  if (info) facts.push(["Size", `${info.width} × ${info.height}`]);
  if (meta?.seed !== undefined) facts.push(["Seed", String(meta.seed)]);
  if (meta?.steps) facts.push(["Steps", String(meta.steps)]);
  if (meta?.cfg) facts.push(["Guidance", String(meta.cfg)]);
  if (meta?.sampler) facts.push(["Sampler", `${meta.sampler} · ${meta.scheduler ?? ""}`]);
  if (meta?.transparent) facts.push(["Background", "Transparent"]);
  if (info) facts.push(["Created", timeAgo(meta?.createdAt ?? info.mtime)]);

  return createPortal(
    <div className={s.lightbox} role="dialog" aria-modal="true" aria-label={item.name}>
      <div className={s.stage} onMouseDown={(e) => e.target === e.currentTarget && onIndex(null)}>
        <IconButton label="Close" className={s.close} onClick={() => onIndex(null)}>
          <X size={20} />
        </IconButton>
        <div className={`${s.stageImage} checker`}>
          {item.compareUrl ? <Compare before={item.compareUrl} after={item.url} /> : <img src={item.url} alt={item.name} />}
        </div>
        {index > 0 && (
          <button type="button" className={`${s.nav} ${s.prev}`} aria-label="Previous" onClick={() => onIndex(index - 1)}>
            <ChevronLeft size={22} />
          </button>
        )}
        {index < items.length - 1 && (
          <button type="button" className={`${s.nav} ${s.next}`} aria-label="Next" onClick={() => onIndex(index + 1)}>
            <ChevronRight size={22} />
          </button>
        )}
      </div>
      <aside className={s.panel}>
        <div>
          <div className={s.panelName}>{item.name}</div>
          <div className={s.panelPath}>{shortPath(item.path)}</div>
        </div>
        {meta?.prompt && <div className={s.promptBlock}>{meta.prompt}</div>}
        {facts.length > 0 && (
          <dl className={s.facts}>
            {facts.map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </span>
            ))}
          </dl>
        )}
        <div className={s.panelActions}>
          {actions?.(item, info)}
          {meta?.prompt && (
            <Button
              icon={<Copy size={16} />}
              onClick={() => navigator.clipboard.writeText(meta.prompt!).then(() => toast("Prompt copied"))}
            >
              Copy prompt
            </Button>
          )}
          <a href={item.url} download={item.name} style={{ display: "contents" }}>
            <Button icon={<Download size={16} />}>Download</Button>
          </a>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** Drag the line to compare the input (left) with the result (right). */
function Compare({ before, after }: { before: string; after: string }) {
  const [x, setX] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setX(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={box}
      style={{ position: "relative", touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => e.buttons && move(e.clientX)}
    >
      <img src={after} alt="Result" draggable={false} />
      <div className={s.compareTop} style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }}>
        <img src={before} alt="Before" draggable={false} />
      </div>
      <div className={s.compareHandle} style={{ left: `${x}%` }} />
      <span className={s.compareLabel} style={{ left: 10 }}>
        Before
      </span>
      <span className={s.compareLabel} style={{ right: 10 }}>
        After
      </span>
    </div>
  );
}
