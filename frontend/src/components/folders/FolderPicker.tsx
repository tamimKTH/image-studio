import { useState } from "react";
import { Check, ChevronDown, Folder as FolderIcon, FolderSearch, Star } from "lucide-react";
import { api } from "../../lib/api";
import { basename, shortPath } from "../../lib/format";
import { rememberFolder, useFolders } from "../../lib/folders";
import { Button, Chip, Popover, cx, toast, usePopover } from "../ui";
import { FolderBrowser } from "./FolderBrowser";
import s from "./folders.module.css";

interface Props {
  /** Chosen folder path; null means the app's default folder. */
  value: string | null;
  onChange: (path: string) => void;
  /** Text before the chip, e.g. "Saving to". */
  prefix?: string;
}

/** "Save to" chip: saved folders one click away, and Browse Mac… for any other folder. */
export function FolderPicker({ value, onChange, prefix }: Props) {
  const { folders, defaultFolder, refresh } = useFolders();
  const pop = usePopover();
  const [browsing, setBrowsing] = useState(false);
  const current = value ?? defaultFolder;
  const known = folders.find((f) => f.path === current);
  const name = known?.name ?? (current ? basename(current) : "Default folder");

  const sorted = [...folders].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  );

  async function choose(path: string) {
    setBrowsing(false);
    pop.close();
    try {
      await rememberFolder(path);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
      return;
    }
    onChange(path);
  }

  async function togglePin(id: string, pinned: boolean) {
    await api.updateFolder(id, { pinned: !pinned }).catch(() => undefined);
    await refresh();
  }

  return (
    <>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {prefix && <span style={{ color: "var(--text-3)", fontSize: "var(--text-sm)" }}>{prefix}</span>}
        <Chip ref={pop.anchor} onClick={pop.toggle} icon={<FolderIcon size={15} />} className={s.pickerChip} title={current ?? undefined}>
          <span className={s.pickerName}>{name}</span>
          <ChevronDown size={14} />
        </Chip>
      </span>
      <Popover anchor={pop.anchor} open={pop.open} onClose={pop.close} title="Save to" width={360}>
        <div className={s.list}>
          {sorted.map((f) => (
            <div key={f.id} className={cx(s.row, f.path === current && s.selected)} role="button" tabIndex={0}
              onClick={() => choose(f.path)} onKeyDown={(e) => e.key === "Enter" && choose(f.path)}>
              <div className={s.cover}>{f.cover ? <img src={f.cover} alt="" /> : <FolderIcon size={17} />}</div>
              <div className={s.rowText}>
                <div className={s.rowName}>{f.name}</div>
                <div className={s.rowPath}>
                  {shortPath(f.path)} · {f.count} {f.count === 1 ? "image" : "images"}
                </div>
              </div>
              <div className={s.rowMeta}>
                {f.path === current && <Check size={16} className={s.check} />}
                <button
                  type="button"
                  className={cx(s.pin, f.pinned && s.pinned)}
                  aria-label={f.pinned ? "Unpin" : "Pin to top"}
                  title={f.pinned ? "Unpin" : "Pin to top"}
                  onClick={(e) => {
                    e.stopPropagation();
                    void togglePin(f.id, f.pinned);
                  }}
                >
                  <Star size={14} fill={f.pinned ? "currentColor" : "none"} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className={s.footer}>
          <Button size="sm" variant="ghost" icon={<FolderSearch size={16} />} onClick={() => setBrowsing(true)}>
            Browse Mac…
          </Button>
        </div>
      </Popover>
      <FolderBrowser open={browsing} onClose={() => setBrowsing(false)} onChoose={choose} initialPath={current} title="Save images to…" />
    </>
  );
}
