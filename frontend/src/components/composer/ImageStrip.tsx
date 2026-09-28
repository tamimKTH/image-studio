import { useEffect, useRef, useState } from "react";
import { Brush, Plus, X } from "lucide-react";
import { api, type Asset } from "../../lib/api";
import { Spinner, cx, toast } from "../ui";
import { MarkArea } from "./MarkArea";
import s from "./composer.module.css";

export const MAX_IMAGES = 10;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/bmp", "image/tiff"];

/** Uploads image files and returns them as assets; non-images are ignored. */
export async function uploadImages(files: File[] | FileList): Promise<Asset[]> {
  const images = Array.from(files).filter((f) => IMAGE_TYPES.includes(f.type) || /\.(png|jpe?g|webp|heic|bmp|tiff?)$/i.test(f.name));
  if (!images.length) return [];
  return api.upload(images);
}

/**
 * Lets a whole area accept dropped and pasted images.
 * Returns `dragging` so the area can show a drop highlight.
 */
export function useImageDrop(onAssets: (assets: Asset[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const cb = useRef(onAssets);
  cb.current = onAssets;

  async function accept(files: FileList | File[]) {
    setBusy(true);
    try {
      const assets = await uploadImages(files);
      if (assets.length) cb.current(assets);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const files = e.clipboardData?.files;
      if (!files?.length) return;
      if (target?.closest("input:not([type=file])")) return;
      e.preventDefault();
      void accept(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [enabled]);

  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!enabled || !e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      void accept(e.dataTransfer.files);
    },
  };
  return { dragging, busy, handlers, accept };
}

interface Props {
  assets: Asset[];
  onChange: (assets: Asset[]) => void;
  uploading?: boolean;
  onAddFiles: (files: FileList) => void;
}

/** Numbered input images: drag to reorder, mark an area, remove. Image 1 is the one being edited. */
export function ImageStrip({ assets, onChange, uploading, onAddFiles }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [marking, setMarking] = useState<Asset | null>(null);

  function move(from: number, to: number) {
    if (from === to) return;
    const next = [...assets];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  }

  return (
    <div className={s.strip}>
      {assets.map((a, i) => (
        <div
          key={`${a.id}-${i}`}
          className={cx(s.thumb, "checker", dragIndex === i && s.dragging, overIndex === i && dragIndex !== i && s.dropTarget)}
          draggable
          title={`image ${i + 1} — write "image ${i + 1}" in the prompt to refer to it${i === 0 ? " (the image being edited)" : ""}`}
          onDragStart={(e) => {
            setDragIndex(i);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(i));
          }}
          onDragEnter={() => dragIndex !== null && setOverIndex(i)}
          onDragOver={(e) => dragIndex !== null && e.preventDefault()}
          onDrop={(e) => {
            if (dragIndex === null) return;
            e.preventDefault();
            e.stopPropagation();
            move(dragIndex, i);
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
        >
          <img src={a.thumb} alt={`Input ${i + 1}`} draggable={false} />
          <span className={s.number}>{i + 1}</span>
          <div className={s.thumbActions}>
            <button type="button" className={s.thumbAction} aria-label="Mark an area" title="Mark an area to change" onClick={() => setMarking(a)}>
              <Brush size={13} />
            </button>
            <button type="button" className={s.thumbAction} aria-label="Remove" title="Remove" onClick={() => onChange(assets.filter((_, j) => j !== i))}>
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
      {uploading && (
        <div className={s.uploading}>
          <Spinner />
        </div>
      )}
      {assets.length < MAX_IMAGES && (
        <button type="button" className={s.addTile} aria-label="Add images" title="Add images" onClick={() => fileInput.current?.click()}>
          <Plus size={20} />
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onAddFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <MarkArea
        asset={marking}
        onClose={() => setMarking(null)}
        onDone={(result, asMask) => {
          const index = assets.findIndex((a) => a.id === marking?.id);
          setMarking(null);
          if (asMask) onChange([...assets, result].slice(0, MAX_IMAGES));
          else onChange(assets.map((a, i) => (i === index ? result : a)));
          toast(asMask ? `Mask added as image ${Math.min(assets.length + 1, MAX_IMAGES)}` : "Marks added — describe the change for the marked area");
        }}
      />
    </div>
  );
}
