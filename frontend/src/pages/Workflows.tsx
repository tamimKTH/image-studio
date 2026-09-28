import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, CopyPlus, FileInput, Layers, MoreHorizontal, Pencil, Play, Plus, Scissors, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { api, type RunSummary, type WorkflowSummary } from "../lib/api";
import { useRunList } from "../lib/events";
import { plural, timeAgo } from "../lib/format";
import { Button, Empty, IconButton, Menu, Modal, Popover, ProgressRing, Spinner, cx, inputClass, textareaClass, toast, usePopover } from "../components/ui";
import s from "./workflows.module.css";

type Starter = "blank" | "combine" | "cutout";

const STARTERS: { key: Starter; title: string; text: string; icon: typeof Plus }[] = [
  { key: "combine", title: "Combine two images", text: "Two images and a prompt make a new image.", icon: Layers },
  { key: "cutout", title: "Cut out and place", text: "Cut a subject out, then place it in a new scene.", icon: Scissors },
  { key: "blank", title: "Blank", text: "Start from an empty canvas.", icon: Plus },
];

const isWorkflowExport = (data: unknown): data is { format: string } =>
  !!data && typeof data === "object" && (data as { format?: string }).format === "image-studio.workflow";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

export function Workflows() {
  const navigate = useNavigate();
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [startersOpen, setStartersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowSummary | null>(null);
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

  const importData = useCallback(
    async (data: unknown, open: boolean) => {
      const wf = await api.importWorkflow(data);
      await refresh();
      if (open) navigate(`/workflows/${wf.id}`);
      else toast(`Pasted “${wf.name}”`, { action: { label: "Open", onClick: () => navigate(`/workflows/${wf.id}`) } });
    },
    [refresh, navigate],
  );

  // ⌘V a copied workflow anywhere on this page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      if (!isWorkflowExport(data)) return;
      e.preventDefault();
      importData(data, false).catch((err: Error) => toast(err.message, { tone: "error" }));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
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
      const data = await api.exportWorkflow(wf.id);
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      toast("Copied — paste it here with ⌘V to make a copy");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

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
    <div className={s.page}>
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
                onRename={() => setRenaming(wf)}
                onDelete={() => remove(wf)}
                onOpenRun={(id) => navigate(`/runs/${id}`)}
              />
            ))}
          </div>
          <p className={s.hint}>Tip: copy a workflow from its menu, then press ⌘V on this page to paste a copy.</p>
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

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onImport={(data) => importData(data, true)} />
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
  onRename: () => void;
  onDelete: () => void;
  onOpenRun: (runId: string) => void;
}

function WorkflowCard({ wf, active, onOpen, onRun, onDuplicate, onCopy, onRename, onDelete, onOpenRun }: CardProps) {
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

function ImportModal({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (data: unknown) => Promise<void> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);

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
