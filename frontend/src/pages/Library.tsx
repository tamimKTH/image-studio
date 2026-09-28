import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Check,
  Copy,
  Folder as FolderIcon,
  FolderPlus,
  FolderX,
  Image as ImageIcon,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, type Folder, type FolderImage } from "../lib/api";
import { useFolderVersion } from "../lib/events";
import { basename, plural, shortPath } from "../lib/format";
import { rememberFolder, useFolders } from "../lib/folders";
import { sendToCreate } from "../lib/handoff";
import { FolderBrowser } from "../components/folders/FolderBrowser";
import { Lightbox, type LightboxItem } from "../components/media/Lightbox";
import {
  Button,
  Empty,
  Field,
  IconButton,
  Menu,
  Modal,
  Popover,
  Spinner,
  cx,
  inputClass,
  toast,
  usePopover,
} from "../components/ui";
import s from "./library.module.css";

const PAGE = 120;
const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

/** The folders the app saves to, and their images. */
export function Library() {
  const navigate = useNavigate();
  const { folders, defaultFolder, refresh, loaded } = useFolders();
  const [params, setParams] = useSearchParams();
  const sorted = useMemo(
    () => [...folders].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
    [folders],
  );
  const path = params.get("path") ?? defaultFolder ?? sorted[0]?.path ?? null;
  const folder = folders.find((f) => f.path === path);
  const version = useFolderVersion(path);

  const [items, setItems] = useState<FolderImage[]>([]);
  const [total, setTotal] = useState(0);
  const [itemsPath, setItemsPath] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [renaming, setRenaming] = useState<Folder | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Read by the loader below without making it reload.
  const loadedCount = useRef(0);
  loadedCount.current = items.length;
  const loadedPath = useRef<string | null>(null);
  const folderMissing = useRef(false);
  folderMissing.current = folder?.exists === false;

  const select = (p: string) => setParams({ path: p });

  // First page (or as many as are shown) whenever the folder or its contents change.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const count = loadedPath.current === path ? Math.max(PAGE, loadedCount.current) : PAGE;
    const done = (list: FolderImage[], n: number) => {
      setItems(list);
      setTotal(n);
      setItemsPath(path);
      loadedPath.current = path;
    };
    api
      .folderImages(path, 0, count)
      .then((r) => !cancelled && done(r.items, r.total))
      .catch((e) => {
        if (cancelled) return;
        done([], 0);
        if (!folderMissing.current) errorToast(e);
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  // Keep the image counts in the folder list current.
  useEffect(() => {
    if (version) refresh().catch(() => undefined);
  }, [version, refresh]);

  async function loadMore() {
    if (!path) return;
    setLoadingMore(true);
    try {
      const r = await api.folderImages(path, items.length, PAGE);
      setItems((prev) => [...prev, ...r.items]);
      setTotal(r.total);
    } catch (e) {
      errorToast(e);
    } finally {
      setLoadingMore(false);
    }
  }

  async function addFolder(p: string) {
    setBrowsing(false);
    try {
      await rememberFolder(p);
      select(p);
    } catch (e) {
      errorToast(e);
    }
  }

  async function togglePin(f: Folder) {
    try {
      await api.updateFolder(f.id, { pinned: !f.pinned });
      await refresh();
    } catch (e) {
      errorToast(e);
    }
  }

  async function rename(f: Folder, name: string) {
    try {
      await api.updateFolder(f.id, { name });
      await refresh();
      setRenaming(null);
    } catch (e) {
      errorToast(e);
    }
  }

  async function forget(f: Folder) {
    try {
      await api.forgetFolder(f.id);
      await refresh();
      if (f.path === path) setParams({});
      toast("Removed from the list — the folder and its images stay on your Mac");
    } catch (e) {
      errorToast(e);
    }
  }

  async function makeDefault(p: string) {
    try {
      await api.saveSettings({ defaultFolder: p });
      await rememberFolder(p);
      toast("New images will be saved here");
    } catch (e) {
      errorToast(e);
    }
  }

  async function sendImageToCreate(image: FolderImage) {
    try {
      sendToCreate([await api.assetFromPath(image.path)]);
      navigate("/");
    } catch (e) {
      errorToast(e);
    }
  }

  const lightboxItems: LightboxItem[] = items.map((i) => ({ url: i.url, path: i.path, name: i.name }));
  const openIndex = openPath ? lightboxItems.findIndex((i) => i.path === openPath) : -1;

  async function trashImage(index: number) {
    const image = items[index];
    if (!image) return;
    try {
      await api.trash(image.path);
      const next = items[index + 1] ?? items[index - 1];
      setItems((prev) => prev.filter((x) => x.path !== image.path));
      setTotal((t) => Math.max(0, t - 1));
      setOpenPath(next ? next.path : null);
      toast("Moved to Trash");
      refresh().catch(() => undefined);
    } catch (e) {
      errorToast(e);
    }
  }

  const showingItems = itemsPath === path;

  return (
    <div className={s.page}>
      <aside className={s.sidebar} aria-label="Folders">
        <h1 className={s.title}>Library</h1>
        <div className={s.sideLabel}>
          Folders
          <IconButton small label="Add a folder" onClick={() => setBrowsing(true)}>
            <Plus size={16} />
          </IconButton>
        </div>
        <div className={s.folderList}>
          {sorted.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              selected={f.path === path}
              isDefault={f.path === defaultFolder}
              onSelect={() => select(f.path)}
              onPin={() => togglePin(f)}
              onRename={() => setRenaming(f)}
              onForget={() => forget(f)}
            />
          ))}
        </div>
        <Button size="sm" variant="ghost" className={s.addFolder} icon={<FolderPlus size={16} />} onClick={() => setBrowsing(true)}>
          Add folder…
        </Button>
      </aside>

      <section className={s.content}>
        {!path ? (
          loaded ? (
            <Empty
              icon={<FolderIcon size={24} />}
              title="No folders yet"
              text="Add a folder from your Mac to browse its images, or create an image — it is saved to your default folder."
              action={
                <Button variant="primary" icon={<FolderPlus size={16} />} onClick={() => setBrowsing(true)}>
                  Add folder
                </Button>
              }
            />
          ) : (
            <div className={s.loading}>
              <Spinner />
            </div>
          )
        ) : (
          <>
            <header className={s.head}>
              <div className={s.headText}>
                <h2 className={s.name}>{folder?.name ?? basename(path)}</h2>
                <div className={s.path}>
                  {shortPath(path)}
                  <IconButton
                    small
                    label="Copy the folder path"
                    onClick={() => navigator.clipboard.writeText(path).then(() => toast("Path copied"))}
                  >
                    <Copy size={13} />
                  </IconButton>
                </div>
              </div>
              <div className={s.headActions}>
                {showingItems && total > 0 && <span className={s.summary}>{plural(total, "image")}</span>}
                {!folder && (
                  <Button size="sm" icon={<Plus size={15} />} onClick={() => addFolder(path)}>
                    Add to folders
                  </Button>
                )}
                {path === defaultFolder ? (
                  <span className={s.badge}>
                    <Check size={15} /> New images are saved here
                  </span>
                ) : (
                  folder?.exists !== false && (
                    <Button size="sm" onClick={() => makeDefault(path)}>
                      Save new images here
                    </Button>
                  )
                )}
              </div>
            </header>

            {folder && !folder.exists ? (
              <Empty
                icon={<FolderX size={24} />}
                title="This folder is gone"
                text="It was moved, renamed or deleted in Finder."
                action={
                  <Button icon={<X size={15} />} onClick={() => forget(folder)}>
                    Remove from the list
                  </Button>
                }
              />
            ) : !showingItems ? (
              <div className={s.loading}>
                <Spinner />
              </div>
            ) : items.length ? (
              <>
                <div className={s.grid}>
                  {items.map((img) => (
                    <button
                      key={img.path}
                      type="button"
                      className={`${s.tile} checker`}
                      title={img.name}
                      onClick={() => setOpenPath(img.path)}
                    >
                      <img src={img.thumb} alt={img.name} loading="lazy" />
                    </button>
                  ))}
                </div>
                {items.length < total && (
                  <Button className={s.loadMore} onClick={loadMore} loading={loadingMore}>
                    Load more
                  </Button>
                )}
              </>
            ) : (
              <Empty
                icon={<ImageIcon size={24} />}
                title="No images here yet"
                text={
                  path === defaultFolder
                    ? "New images from Create and your workflows are saved here."
                    : "Pick this folder in “Saving to” on Create, or make it the default above."
                }
                action={
                  <Button variant="primary" icon={<Sparkles size={16} />} onClick={() => navigate("/")}>
                    Create an image
                  </Button>
                }
              />
            )}
          </>
        )}
      </section>

      <FolderBrowser
        open={browsing}
        onClose={() => setBrowsing(false)}
        onChoose={addFolder}
        initialPath={path}
        title="Add a folder"
        confirmLabel="Add this folder"
      />
      <RenameModal folder={renaming} onClose={() => setRenaming(null)} onSave={rename} />
      <Lightbox
        items={lightboxItems}
        index={openIndex >= 0 ? openIndex : null}
        onIndex={(i) => setOpenPath(i === null ? null : lightboxItems[i]?.path ?? null)}
        actions={(item) => {
          const index = items.findIndex((x) => x.path === item.path);
          const image = items[index];
          if (!image) return null;
          return (
            <>
              <Button icon={<ImagePlus size={16} />} onClick={() => sendImageToCreate(image)}>
                Use in Create
              </Button>
              <Button icon={<Trash2 size={16} />} onClick={() => trashImage(index)}>
                Move to Trash
              </Button>
            </>
          );
        }}
      />
    </div>
  );
}

interface FolderRowProps {
  folder: Folder;
  selected: boolean;
  isDefault: boolean;
  onSelect: () => void;
  onPin: () => void;
  onRename: () => void;
  onForget: () => void;
}

function FolderRow({ folder, selected, isDefault, onSelect, onPin, onRename, onForget }: FolderRowProps) {
  const pop = usePopover();
  const meta = !folder.exists ? "Missing on disk" : `${isDefault ? "Default · " : ""}${plural(folder.count, "image")}`;
  return (
    <div
      className={cx(s.folder, selected && s.selected)}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      title={folder.path}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onSelect()}
    >
      <div className={s.cover}>{folder.cover ? <img src={folder.cover} alt="" /> : <FolderIcon size={18} />}</div>
      <div className={s.folderText}>
        <div className={s.folderName}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{folder.name}</span>
          {folder.pinned && <Star size={12} fill="currentColor" className={s.pinIcon} aria-label="Pinned" />}
        </div>
        <div className={cx(s.folderMeta, !folder.exists && s.missing)}>{meta}</div>
      </div>
      <IconButton
        ref={pop.anchor}
        small
        label="Folder options"
        className={s.more}
        onClick={(e) => {
          e.stopPropagation();
          pop.toggle();
        }}
      >
        <MoreHorizontal size={16} />
      </IconButton>
      <Popover anchor={pop.anchor} open={pop.open} onClose={pop.close} placement="bottom-end">
        {/* The popover is portalled, but React still bubbles its clicks to this row. */}
        <div onClick={(e) => e.stopPropagation()}>
          <Menu
            onDone={pop.close}
            items={[
              { label: folder.pinned ? "Unpin" : "Pin to top", icon: <Star size={16} />, onSelect: onPin },
              { label: "Rename label", icon: <Pencil size={16} />, onSelect: onRename },
              { label: "Remove from list", icon: <X size={16} />, onSelect: onForget, danger: true, separatorBefore: true },
            ]}
          />
        </div>
      </Popover>
    </div>
  );
}

function RenameModal({ folder, onClose, onSave }: { folder: Folder | null; onClose: () => void; onSave: (f: Folder, name: string) => void }) {
  const [name, setName] = useState("");
  useEffect(() => setName(folder?.name ?? ""), [folder]);
  const submit = () => folder && name.trim() && onSave(folder, name.trim());
  return (
    <Modal
      open={!!folder}
      onClose={onClose}
      title="Rename label"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name shown in the app" hint="The folder on your Mac keeps its own name.">
        <input
          className={inputClass}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </Field>
    </Modal>
  );
}
