import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ChevronRight,
  Download,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  HardDrive,
  Home,
  Image,
  Monitor,
  Sparkles,
} from "lucide-react";
import { api, type FsListing } from "../../lib/api";
import { shortPath } from "../../lib/format";
import { Button, Modal, Spinner, cx, inputClass, toast } from "../ui";
import s from "./folders.module.css";

const PLACE_ICON: Record<string, typeof Home> = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  studio: Sparkles,
  volume: HardDrive,
};

interface Props {
  open: boolean;
  onClose: () => void;
  onChoose: (path: string) => void;
  initialPath?: string | null;
  title?: string;
  confirmLabel?: string;
}

/** Walk the Mac's folders, create one, and choose the folder that is open. */
export function FolderBrowser({ open, onClose, onChoose, initialPath, title = "Choose a folder", confirmLabel = "Choose this folder" }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  const go = useCallback(async (path?: string | null) => {
    setLoading(true);
    try {
      setListing(await api.listDir(path ?? undefined));
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
      if (path) setListing(await api.listDir().catch(() => null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setNewName(null);
      void go(initialPath);
    }
  }, [open, initialPath, go]);

  async function createFolder(e: FormEvent) {
    e.preventDefault();
    if (!listing || !newName?.trim()) return;
    try {
      const { path } = await api.makeDir(listing.path, newName.trim());
      setNewName(null);
      await go(path);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="wide"
      footer={
        <>
          <span className={s.current}>{listing ? shortPath(listing.path) : ""}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!listing} onClick={() => listing && onChoose(listing.path)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={s.browser}>
        <div className={s.places}>
          {listing?.places.map((p) => {
            const Icon = PLACE_ICON[p.kind] ?? FolderIcon;
            return (
              <button key={p.path} type="button" className={cx(s.place, listing.path === p.path && s.here)} onClick={() => go(p.path)}>
                <Icon size={17} />
                {p.name}
              </button>
            );
          })}
        </div>
        <div className={s.pane}>
          <div className={s.crumbs}>
            {listing?.crumbs.map((c, i) => (
              <span key={c.path} style={{ display: "contents" }}>
                {i > 0 && <ChevronRight size={14} />}
                <button type="button" className={s.crumb} onClick={() => go(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" icon={<FolderPlus size={16} />} onClick={() => setNewName("")} disabled={!listing}>
              New folder
            </Button>
          </div>
          <div className={s.dirs}>
            {newName !== null && (
              <form className={s.newRow} onSubmit={createFolder}>
                <input
                  autoFocus
                  className={inputClass}
                  placeholder="Folder name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNewName(null))}
                />
                <Button type="submit" variant="primary" disabled={!newName.trim()}>
                  Create
                </Button>
              </form>
            )}
            {loading && !listing ? (
              <div className={s.muted}>
                <Spinner />
              </div>
            ) : listing?.dirs.length ? (
              listing.dirs.map((d) => (
                <button key={d.path} type="button" className={s.dir} onClick={() => go(d.path)}>
                  <FolderIcon size={18} />
                  <span>{d.name}</span>
                  <ChevronRight size={16} />
                </button>
              ))
            ) : (
              <div className={s.muted}>No folders inside. You can choose this one or create a new folder.</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
