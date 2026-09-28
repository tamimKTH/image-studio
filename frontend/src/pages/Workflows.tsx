import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Copy,
  CopyPlus,
  FileDown,
  FileInput,
  FileUp,
  Layers,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Scissors,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { api, type RunSummary, type WorkflowSummary } from "../lib/api";
import { useRunList } from "../lib/events";
import { plural, timeAgo } from "../lib/format";
import { inTextField, isMac, shortcut } from "../lib/keys";
import { Button, Empty, IconButton, Menu, Modal, Popover, ProgressRing, Spinner, cx, inputClass, textareaClass, toast, usePopover } from "../components/ui";
import { copyWorkflow, exportWorkflowFile, isWorkflowExport, jsonFileIn, readWorkflowFile } from "../flow/transfer";
import s from "./workflows.module.css";

type Starter = "blank" | "combine" | "cutout";

const STARTERS: { key: Starter; title: string; text: string; icon: typeof Plus }[] = [
  { key: "combine", title: "Combine two images", text: "Two images and a prompt make a new image.", icon: Layers },
  { key: "cutout", title: "Cut out and place", text: "Cut a subject out, then place it in a new scene.", icon: Scissors },
  { key: "blank", title: "Blank", text: "Start from an empty canvas.", icon: Plus },
];

export function Workflows() {
  const navigate = useNavigate();
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [startersOpen, setStartersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const runs = useRunList();

  const refresh = useCallback(async () => {
    try {
      setList(await api.workflows());
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
      setList((l) => l ?? []);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  // Refresh covers and "last run" when a run of one of these workflows finishes.
  const finishedKey = runs.filter((r) => r.workflowId && (r.status === "done" || r.status === "failed")).length;
  useEffect(() => {
    if (finishedKey) void refresh();
  }, [finishedKey, refresh]);

  const activeByWorkflow = useMemo(() => {
    const map = new Map<string, RunSummary>();
    for (const r of runs) if (r.workflowId && (r.status === "queued" || r.status === "running") && !map.has(r.workflowId)) map.set(r.workflowId, r);
    return map;
  }, [runs]);

  /** Adds a workflow from a copy or a file, then opens it — or says so (`how`) and offers to open it. */
  const importData = useCallback(
    async (data: unknown, how: "open" | "Pasted" | "Imported") => {
      const wf = await api.importWorkflow(data);
      await refresh();
      if (how === "open") navigate(`/workflows/${wf.id}`);
      else toast(`${how} “${wf.name}”`, { action: { label: "Open", onClick: () => navigate(`/workflows/${wf.id}`) } });
    },
    [refresh, navigate],
  );

  // Paste (⌘V / Ctrl+V) a copied workflow anywhere on this page.
  useEffect(() => {
    const pasteText = (text: string | undefined, e: Event) => {
      if (!text || inTextField(e) || document.querySelector('[aria-modal="true"]')) return false;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return false;
      }
      if (!isWorkflowExport(data)) return false;
      importData(data, "Pasted").catch((err: Error) => toast(err.message, { tone: "error" }));
      return true;
    };
    const onPaste = (e: ClipboardEvent) => {
      if (pasteText(e.clipboardData?.getData("text/plain"), e)) e.preventDefault();
    };
    // On a Mac only ⌘V fires a paste event; Ctrl+V (Windows habit) reads the clipboard directly.
    const onKey = (e: KeyboardEvent) => {
      if (!isMac || !e.ctrlKey || e.metaKey || e.key.toLowerCase() !== "v" || inTextField(e)) return;
      navigator.clipboard.readText().then((text) => pasteText(text, e), () => undefined);
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
    };
  }, [importData]);

  async function createFrom(starter: Starter) {
    setStartersOpen(false);
    try {
      const wf = await api.createWorkflow({ starter });
      navigate(`/workflows/${wf.id}`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function run(wf: WorkflowSummary) {
    try {
      const { runId } = await api.runWorkflow(wf.id);
      toast(`Running “${wf.name}”`, { action: { label: "View", onClick: () => navigate(`/runs/${runId}`) } });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function duplicate(wf: WorkflowSummary) {
    try {
      const copy = await api.duplicateWorkflow(wf.id);
      await refresh();
      toast(`Duplicated as “${copy.name}”`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function copy(wf: WorkflowSummary) {
    try {
      await copyWorkflow(wf.id);
      toast(`Copied — paste it here with ${shortcut("V")} to make a copy`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function exportFile(wf: WorkflowSummary) {
    try {
      await exportWorkflowFile(wf.id, wf.name);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  // A workflow file dropped anywhere on the page is imported.
  const pageDrop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files") || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      setFileOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false);
    },
    onDrop: async (e: DragEvent) => {
      const file = jsonFileIn(e.dataTransfer.files);
      setFileOver(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      if (!file) return toast("Drop a workflow file (.studio.json) here", { tone: "error" });
      try {
        await importData(await readWorkflowFile(file), "Imported");
      } catch (err) {
        toast((err as Error).message, { tone: "error" });
      }
    },
  };

  function remove(wf: WorkflowSummary) {
    const unhide = () =>
      setHidden((h) => {
        const next = new Set(h);
        next.delete(wf.id);
        return next;
      });
    setHidden((h) => new Set(h).add(wf.id));
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.deleteWorkflow(wf.id);
      } catch (e) {
        toast((e as Error).message, { tone: "error" });
        unhide();
      }
      void refresh();
    }, 6000);
    toast(`Deleted “${wf.name}”`, {
      ms: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          undone = true;
          clearTimeout(timer);
          unhide();
        },
      },
    });
  }

  const visible = (list ?? []).filter((w) => !hidden.has(w.id));

  return (
    <div className={cx(s.page, fileOver && s.fileOver)} {...pageDrop}>
      <div className={s.header}>
        <div className={s.titles}>
          <h1 className={s.title}>Workflows</h1>
          <p className={s.subtitle}>Chain image steps into a flow — run it, and it keeps going in the background.</p>
        </div>
        <Button icon={<FileInput size={16} />} onClick={() => setImportOpen(true)}>
          Import
        </Button>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setStartersOpen(true)}>
          New workflow
        </Button>
      </div>

      {list === null ? (
        <div style={{ display: "grid", placeItems: "center", padding: 64 }}>
          <Spinner size={22} />
        </div>
      ) : visible.length === 0 ? (
        <Empty
          icon={<WorkflowIcon size={24} />}
          title="No workflows yet"
          text="A workflow connects images and Generate steps, so one result can feed the next. Start from one of these:"
          action={
            <div className={s.emptyStarters}>
              {STARTERS.map(({ key, title, icon: Icon }) => (
                <Button key={key} icon={<Icon size={16} />} onClick={() => createFrom(key)}>
                  {title}
                </Button>
              ))}
            </div>
          }
        />
      ) : (
        <>
          <div className={s.grid}>
            {visible.map((wf) => (
              <WorkflowCard
                key={wf.id}
                wf={wf}
                active={activeByWorkflow.get(wf.id)}
                onOpen={() => navigate(`/workflows/${wf.id}`)}
                onRun={() => run(wf)}
                onDuplicate={() => duplicate(wf)}
                onCopy={() => copy(wf)}
                onExport={() => exportFile(wf)}
                onRename={() => setRenaming(wf)}
                onDelete={() => remove(wf)}
                onOpenRun={(id) => navigate(`/runs/${id}`)}
              />
            ))}
          </div>
          <p className={s.hint}>
            Tip: copy a workflow from its menu, then press {shortcut("V")} on this page to paste a copy — or drop a .studio.json file here to import it.
          </p>
        </>
      )}

      <Modal open={startersOpen} onClose={() => setStartersOpen(false)} title="New workflow">
        <div className={s.starters}>
          {STARTERS.map(({ key, title, text, icon: Icon }) => (
            <button key={key} type="button" className={s.starter} onClick={() => createFrom(key)}>
              <span className={s.starterIcon}>
                <Icon size={18} />
              </span>
              <span>
                <div className={s.starterTitle}>{title}</div>
                <div className={s.starterText}>{text}</div>
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onImport={(data) => importData(data, "open")} />
      <RenameModal
        workflow={renaming}
        onClose={() => setRenaming(null)}
        onSaved={() => {
          setRenaming(null);
          void refresh();
        }}
      />
    </div>
  );
}

interface CardProps {
  wf: WorkflowSummary;
  active?: RunSummary;
  onOpen: () => void;
  onRun: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onExport: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenRun: (runId: string) => void;
}

function WorkflowCard({ wf, active, onOpen, onRun, onDuplicate, onCopy, onExport, onRename, onDelete, onOpenRun }: CardProps) {
  const menu = usePopover();
  const last = wf.lastRun;
  return (
    <div
      className={s.card}
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}
      aria-label={`Open ${wf.name}`}
    >
      <div className={cx(s.cover, wf.cover && "checker")}>
        {wf.cover ? <img src={wf.cover} alt="" /> : <DiagramGlyph />}
        {active && (
          <button
            type="button"
            className={s.running}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRun(active.id);
            }}
            title="Open the run"
          >
            <ProgressRing size={16} stroke={2.5} value={active.progress || undefined} />
            {active.status === "queued" ? "In queue" : `Running · ${active.done} of ${active.total}`}
          </button>
        )}
      </div>
      <div className={s.body}>
        <div className={s.name}>{wf.name}</div>
        <div className={s.meta}>
          {plural(wf.nodeCount, "node")} · edited {timeAgo(wf.updatedAt)}
          {!active && last?.status === "failed" && <span className={s.lastFailed}> · last run failed</span>}
        </div>
      </div>
      <IconButton
        ref={menu.anchor}
        label="Workflow actions"
        className={s.menuButton}
        aria-expanded={menu.open}
        onClick={(e) => {
          e.stopPropagation();
          menu.toggle();
        }}
      >
        <MoreHorizontal size={18} />
      </IconButton>
      <Popover anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={200}>
        <div onClick={(e) => e.stopPropagation()}>
          <Menu
            onDone={menu.close}
            items={[
              { label: "Open", icon: <Pencil size={16} />, onSelect: onOpen },
              { label: "Run", icon: <Play size={16} />, onSelect: onRun },
              { label: "Duplicate", icon: <CopyPlus size={16} />, onSelect: onDuplicate, separatorBefore: true },
              { label: "Copy", icon: <Copy size={16} />, onSelect: onCopy },
              { label: "Export file…", icon: <FileDown size={16} />, onSelect: onExport },
              { label: "Rename", icon: <Pencil size={16} />, onSelect: onRename },
              { label: "Delete", icon: <Trash2 size={16} />, onSelect: onDelete, danger: true, separatorBefore: true },
            ]}
          />
        </div>
      </Popover>
    </div>
  );
}

/** Placeholder cover: a tiny node diagram. */
function DiagramGlyph() {
  return (
    <svg className={s.placeholder} viewBox="0 0 160 90" fill="none" aria-hidden>
      <rect x="6" y="12" width="40" height="26" rx="6" stroke="currentColor" strokeWidth="2.5" />
      <rect x="6" y="52" width="40" height="26" rx="6" stroke="currentColor" strokeWidth="2.5" />
      <rect x="62" y="32" width="40" height="26" rx="6" stroke="currentColor" strokeWidth="2.5" />
      <rect x="116" y="32" width="38" height="26" rx="6" stroke="currentColor" strokeWidth="2.5" />
      <path d="M46 25 C56 25 52 45 62 45 M46 65 C56 65 52 45 62 45 M102 45 H116" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

/** Import from a .studio.json file (choose or drop) or from pasted text. */
function ImportModal({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (data: unknown) => Promise<void> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);

  async function importData(data: unknown) {
    setBusy(true);
    try {
      await onImport(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File | null) {
    if (!file) return setError("Choose a workflow file (.studio.json).");
    try {
      await importData(await readWorkflowFile(file));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit() {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      setError("That isn't valid workflow text. Copy a workflow from its ⋯ menu and paste it here.");
      return;
    }
    if (!isWorkflowExport(data)) {
      setError("That text isn't an Image Studio workflow.");
      return;
    }
    await importData(data);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import a workflow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!text.trim()}>
            Import
          </Button>
        </>
      }
    >
      <div
        className={cx(s.importDrop, over && s.importDropOver)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void importFile(jsonFileIn(e.dataTransfer.files));
        }}
      >
        <FileUp size={20} />
        <span>Drop a .studio.json file here</span>
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
          Choose file…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            void importFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
      </div>
      <div className={s.importOr}>or paste a copied workflow</div>
      <textarea
        className={cx(textareaClass, s.importArea)}
        placeholder="Paste a copied workflow here"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        autoFocus
      />
      {error && <div className={s.importError}>{error}</div>}
    </Modal>
  );
}

function RenameModal({ workflow, onClose, onSaved }: { workflow: WorkflowSummary | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(workflow?.name ?? ""), [workflow]);

  async function save() {
    if (!workflow || !name.trim()) return;
    setBusy(true);
    try {
      await api.saveWorkflow(workflow.id, { name: name.trim() });
      onSaved();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!workflow}
      onClose={onClose}
      title="Rename workflow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <input
        className={inputClass}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void save()}
        aria-label="Name"
      />
    </Modal>
  );
}
