import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type FitViewOptions,
  type HandleType,
  type OnConnectEnd,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  FileDown,
  ImagePlus,
  MoreHorizontal,
  Play,
  Redo2,
  Scissors,
  Sparkles,
  StickyNote,
  Undo2,
} from "lucide-react";
import { api, type Asset, type GraphEdge, type GraphNode, type NodeType, type NoteColor, type Workflow } from "../lib/api";
import { useRun, useRunList } from "../lib/events";
import { plural } from "../lib/format";
import { inTextField, isMac, isMod, shortcut } from "../lib/keys";
import { useResolvedTheme } from "../lib/prefs";
import { uploadImages } from "../components/composer/ImageStrip";
import { FolderPicker } from "../components/folders/FolderPicker";
import { stepLabel } from "../components/media/ImageCard";
import { Button, Empty, IconButton, Menu, Popover, ProgressRing, Spinner, cx, toast, usePopover } from "../components/ui";
import { rememberAsset } from "../flow/assets";
import { DropMenu, type DropMenuState } from "../flow/DropMenu";
import {
  NODE_WIDTH,
  NOTE_SIZE,
  connectionProblem,
  connectionToCard,
  freeSpot,
  fromFlow,
  isNodeClipboard,
  nodeHeight,
  nodeSize,
  runProgress,
  validate,
  type FlowNode,
  type NodeClipboard,
} from "../flow/graph";
import { NodePanel } from "../flow/NodePanel";
import { FlowContext, nodeTypes, type FlowContextValue } from "../flow/nodes";
import { OutputLightbox, useDeletedOutputs } from "../flow/OutputLightbox";
import { copyWorkflow, exportWorkflowFile, isWorkflowExport } from "../flow/transfer";
import { useGraph } from "../flow/useGraph";
import s from "../flow/flow.module.css";

export function WorkflowEditor() {
  const { id } = useParams();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setWorkflow(null);
    setError(null);
    api.workflow(id).then(setWorkflow).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div className={s.center}>
        <Empty
          icon={<AlertTriangle size={24} />}
          title="This workflow can't be opened"
          text={error}
          action={
            <Link to="/workflows">
              <Button>Back to workflows</Button>
            </Link>
          }
        />
      </div>
    );
  if (!workflow)
    return (
      <div className={s.center}>
        <Spinner size={22} />
      </div>
    );
  return (
    <ReactFlowProvider>
      <Editor key={workflow.id} workflow={workflow} />
    </ReactFlowProvider>
  );
}

/**
 * Copied nodes are also kept for this browser tab, so they paste into another workflow (and after a reload)
 * even when the system clipboard can't be written or read.
 */
const BUFFER_KEY = "studio.copiedNodes";

function keepCopied(clip: NodeClipboard) {
  try {
    sessionStorage.setItem(BUFFER_KEY, JSON.stringify(clip));
  } catch {
    /* only the system clipboard then */
  }
}

async function copiedNodes(): Promise<NodeClipboard | null> {
  try {
    const kept = JSON.parse(sessionStorage.getItem(BUFFER_KEY) ?? "null");
    if (isNodeClipboard(kept)) return kept;
  } catch {
    /* fall through to the system clipboard */
  }
  try {
    const text = await navigator.clipboard.readText();
    const data = JSON.parse(text);
    return isNodeClipboard(data) ? data : null;
  } catch {
    return null;
  }
}

const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

/** Fitting the workflow in view keeps it clear of the floating toolbar at the bottom. */
const FIT_VIEW: FitViewOptions = { padding: { top: "56px", right: "56px", bottom: "112px", left: "56px" }, maxZoom: 1 };

/** The canvas node under a screen point, if any. */
function nodeAt(x: number, y: number): string | null {
  return document.elementFromPoint(x, y)?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
}

const pointOf = (event: MouseEvent | TouchEvent) => ("changedTouches" in event ? event.changedTouches[0] : event);

function Editor({ workflow }: { workflow: Workflow }) {
  const navigate = useNavigate();
  const g = useGraph(workflow.graph);
  const { updateData, undo, redo, duplicateSelected, selectOnly, selectAll, addNode, nodesRef, edgesRef, connect, reconnect, removeEdge, paste, copy, cut } = g;
  const flow = useReactFlow();
  const theme = useResolvedTheme();
  const wrapper = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [name, setName] = useState(workflow.name);
  const [folder, setFolder] = useState<string | null>(workflow.folder);
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null);
  const [lightbox, setLightbox] = useState<{ nodeId: string; index: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [filesOver, setFilesOver] = useState(false);
  const runningRef = useRef(false);
  const moving = useRef<{ edge: Edge; done: boolean } | null>(null);
  const moreMenu = usePopover();

  // ---------- autosave ----------
  const graph = useMemo(() => fromFlow(g.nodes, g.edges), [g.nodes, g.edges]);
  const payload = useMemo(() => JSON.stringify({ name: name.trim() || "Untitled workflow", folder, graph }), [name, folder, graph]);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const savedRef = useRef(payload);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");

  const flush = useCallback(async (): Promise<boolean> => {
    const p = payloadRef.current;
    if (p === savedRef.current) return true;
    setSaveState("saving");
    try {
      await api.saveWorkflow(workflow.id, JSON.parse(p));
      savedRef.current = p;
      setSaveState(payloadRef.current === p ? "saved" : "saving");
      return true;
    } catch {
      setSaveState("error");
      return false;
    }
  }, [workflow.id]);

  useEffect(() => {
    // Back to the saved state (e.g. an undo right after a change): nothing to save.
    if (payload === savedRef.current) {
      setSaveState((st) => (st === "saving" ? "saved" : st));
      return;
    }
    setSaveState("saving");
    const t = setTimeout(() => void flush(), 600);
    return () => clearTimeout(t);
  }, [payload, flush]);

  useEffect(() => {
    const onUnload = () => {
      if (payloadRef.current === savedRef.current) return;
      fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payloadRef.current,
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      onUnload();
    };
  }, [workflow.id]);

  // ---------- latest run shown on the nodes ----------
  const runs = useRunList();
  const latest = runs.find((r) => r.workflowId === workflow.id);
  const { run: latestRun } = useRun(latest?.id);
  const active = !!latest && (latest.status === "queued" || latest.status === "running");
  const { hide, onRemoved } = useDeletedOutputs();
  const states = useMemo(() => hide(latestRun?.nodes ?? null), [hide, latestRun?.nodes]);

  const setImageAsset = useCallback((nodeId: string, asset: Asset) => updateData(nodeId, { asset: asset.id }), [updateData]);
  const setNote = useCallback(
    (nodeId: string, patch: { text?: string; color?: NoteColor }) =>
      updateData(nodeId, patch, patch.text !== undefined ? `note-text:${nodeId}` : undefined),
    [updateData],
  );
  const ctx = useMemo<FlowContextValue>(
    () => ({
      readOnly: false,
      runId: latest?.id ?? null,
      states,
      showAllStates: false,
      onImageAsset: setImageAsset,
      onOpenOutputs: (nodeId) => setLightbox({ nodeId, index: 0 }),
      onNoteChange: setNote,
    }),
    [latest?.id, states, setImageAsset, setNote],
  );

  const displayEdges = useMemo<Edge[]>(() => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    return g.edges.map((e) => {
      const target = byId.get(e.target);
      const index = target?.type === "generate" ? target.data.inputs.indexOf(e.source) : -1;
      return {
        ...e,
        label: index >= 0 ? String(index + 1) : undefined,
        labelBgPadding: [7, 3] as [number, number],
        labelBgBorderRadius: 9,
        labelStyle: { fill: "var(--text-2)", fontWeight: 700, fontSize: 11 },
        labelBgStyle: { fill: "var(--surface)", stroke: "var(--border-strong)" },
        interactionWidth: 26,
        // Grab a connection by its input end to move it to another node, or drop it on empty canvas to remove it.
        reconnectable: "target" as const,
        animated: active && states?.[e.target]?.status === "running",
      };
    });
  }, [g.edges, g.nodes, active, states]);

  // ---------- adding nodes ----------
  const viewCenter = useCallback(() => {
    const r = wrapper.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }, [flow]);

  function addFromToolbar(type: NodeType) {
    const selected = nodesRef.current.filter((n) => n.selected);
    if ((type === "generate" || type === "removeBackground") && selected.length === 1 && selected[0].type !== "note") {
      // Continue from the selected node: to its right, on the same row when there is room.
      const from = selected[0];
      const pos = freeSpot({ x: from.position.x + nodeSize(from).width + 90, y: from.position.y }, type, nodesRef.current);
      addNode(type, pos, { from: from.id });
      const x = (from.position.x + pos.x + NODE_WIDTH) / 2;
      const y = (from.position.y + pos.y + nodeHeight(type)) / 2;
      flow.setCenter(x, y, { zoom: flow.getZoom(), duration: 300 });
      return;
    }
    const c = viewCenter();
    const w = type === "note" ? NOTE_SIZE.width : NODE_WIDTH;
    addNode(type, freeSpot({ x: c.x - w / 2, y: c.y - nodeHeight(type) / 2 }, type, nodesRef.current));
  }

  const addImages = useCallback(
    (assets: Asset[], at?: { x: number; y: number }) => {
      const c = viewCenter();
      let p = at ?? { x: c.x - NODE_WIDTH / 2, y: c.y - nodeHeight("image") / 2 };
      for (const a of assets) {
        rememberAsset(a);
        p = freeSpot(p, "image", nodesRef.current);
        addNode("image", p, { data: { asset: a.id } });
      }
    },
    [addNode, nodesRef, viewCenter],
  );

  // ---------- connections ----------
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      // A connection being moved doesn't block its own new place.
      const movingId = moving.current?.edge.id;
      const edges = movingId ? edgesRef.current.filter((e) => e.id !== movingId) : edgesRef.current;
      return connectionProblem(c.source, c.target, nodesRef.current, edges) === null;
    },
    [nodesRef, edgesRef],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (moving.current || state.isValid || !state.fromNode) return;
      const { clientX, clientY } = pointOf(event);
      const fromType: HandleType = state.fromHandle?.type === "target" ? "target" : "source";
      // Released over a node's card (or a dot that can't take it): connect to that node the way it can be connected.
      const onto = state.toHandle?.nodeId ?? nodeAt(clientX, clientY);
      if (onto && onto !== state.fromNode.id) {
        connect(connectionToCard(state.fromNode.id, fromType, onto));
        return;
      }
      if (onto) return;
      if (!document.elementFromPoint(clientX, clientY)?.closest(".react-flow__pane")) return;
      setDropMenu({ x: clientX, y: clientY, nodeId: state.fromNode.id, handle: fromType });
    },
    [connect],
  );

  const onReconnectStart = useCallback((_: unknown, edge: Edge) => {
    moving.current = { edge, done: false };
  }, []);

  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      if (moving.current) moving.current.done = true;
      reconnect(old, c);
    },
    [reconnect],
  );

  const onReconnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, edge: Edge, fixedEnd: HandleType, state: FinalConnectionState) => {
      const m = moving.current;
      moving.current = null;
      if (!m || m.done) return;
      const { clientX, clientY } = pointOf(event);
      const onto = state.toHandle?.nodeId ?? nodeAt(clientX, clientY);
      if (onto) {
        reconnect(edge, fixedEnd === "source" ? { source: edge.source, target: onto } : { source: onto, target: edge.target });
        return;
      }
      removeEdge(edge.id);
      toast("Connection removed", { action: { label: "Undo", onClick: undo } });
    },
    [reconnect, removeEdge, undo],
  );

  function pickFromDropMenu(type: NodeType) {
    if (!dropMenu) return;
    const p = flow.screenToFlowPosition({ x: dropMenu.x, y: dropMenu.y });
    const wanted = { x: dropMenu.handle === "source" ? p.x : p.x - NODE_WIDTH, y: p.y - 60 };
    const at = freeSpot(wanted, type, nodesRef.current);
    if (dropMenu.handle === "source") addNode(type, at, { from: dropMenu.nodeId });
    else addNode(type, at, { to: dropMenu.nodeId });
    setDropMenu(null);
  }

  // ---------- clipboard ----------
  const pasteClip = useCallback(
    (clip: { nodes: GraphNode[]; edges: GraphEdge[] }) => {
      const r = wrapper.current?.getBoundingClientRect();
      const p = pointer.current;
      let at;
      if (p && r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) at = flow.screenToFlowPosition(p);
      else at = { x: Math.min(...clip.nodes.map((n) => n.position?.x ?? 0)), y: Math.min(...clip.nodes.map((n) => n.position?.y ?? 0)) };
      const count = paste(clip, at);
      if (count) toast(`Pasted ${plural(count, "node")}`);
    },
    [flow, paste],
  );

  // Dropping image files on the canvas makes image nodes where they land.
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setFilesOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setFilesOver(false);
    },
    onDrop: async (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setFilesOver(false);
      const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      try {
        const assets = await uploadImages(e.dataTransfer.files);
        if (!assets.length) return toast("Only images can be dropped here", { tone: "error" });
        addImages(assets, { x: at.x - NODE_WIDTH / 2, y: at.y - 80 });
      } catch (err) {
        toast((err as Error).message, { tone: "error" });
      }
    },
  };

  // ---------- run ----------
  const run = useCallback(async () => {
    if (runningRef.current) return;
    const problem = validate(nodesRef.current, edgesRef.current);
    if (problem) {
      toast(problem.message, { tone: "error" });
      if (problem.nodeId) selectOnly(problem.nodeId);
      return;
    }
    runningRef.current = true;
    setStarting(true);
    try {
      if (!(await flush())) throw new Error("The workflow couldn't be saved");
      const { runId } = await api.runWorkflow(workflow.id);
      toast("Running — it keeps going in the background", { action: { label: "View", onClick: () => navigate(`/runs/${runId}`) } });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      runningRef.current = false;
      setStarting(false);
    }
  }, [nodesRef, edgesRef, selectOnly, flush, workflow.id, navigate]);

  // ---------- keyboard and paste (⌘ on a Mac, Ctrl elsewhere — both work everywhere) ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = isMod(e);
      const key = e.key.toLowerCase();
      if (mod && key === "enter") {
        if (modalOpen()) return;
        e.preventDefault();
        void run();
        return;
      }
      if (e.key === "Escape" && !document.querySelector('[aria-modal="true"], [role="dialog"]')) {
        (document.activeElement as HTMLElement | null)?.blur();
        selectOnly(null);
        return;
      }
      if (!mod || inTextField(e) || modalOpen()) return;
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "d") {
        e.preventDefault();
        duplicateSelected();
      } else if (key === "a") {
        e.preventDefault();
        selectAll();
      } else if (key === "c" || key === "x") {
        const clip = key === "c" ? copy() : cut();
        if (!clip) return;
        e.preventDefault();
        keepCopied(clip);
        navigator.clipboard?.writeText(JSON.stringify(clip)).catch(() => undefined);
        const what = plural(clip.nodes.length, "node");
        toast(key === "c" ? `Copied ${what} — paste with ${shortcut("V")}` : `Cut ${what}`, key === "x" ? { action: { label: "Undo", onClick: undo } } : {});
      } else if (key === "v") {
        // ⌘V on a Mac and Ctrl+V elsewhere also fire the browser's paste event, handled below.
        if (isMac ? e.metaKey : e.ctrlKey) return;
        e.preventDefault();
        void copiedNodes().then((clip) => clip && pasteClip(clip));
      }
    };
    const onPaste = async (e: ClipboardEvent) => {
      if (inTextField(e) || modalOpen()) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      let data: unknown = null;
      if (text.trim().startsWith("{")) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (isNodeClipboard(data)) {
        e.preventDefault();
        pasteClip(data);
        return;
      }
      if (isWorkflowExport(data) && (data as { graph?: { nodes?: unknown } }).graph) {
        // A whole copied workflow pasted into this one: its nodes are added here.
        e.preventDefault();
        pasteClip((data as unknown as { graph: { nodes: GraphNode[]; edges: GraphEdge[] } }).graph);
        return;
      }
      if (e.clipboardData?.files.length) {
        e.preventDefault();
        try {
          const assets = await uploadImages(e.clipboardData.files);
          if (assets.length) addImages(assets);
        } catch (err) {
          toast((err as Error).message, { tone: "error" });
        }
        return;
      }
      if (!text) {
        e.preventDefault();
        const clip = await copiedNodes();
        if (clip) pasteClip(clip);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, [undo, redo, duplicateSelected, selectAll, selectOnly, run, addImages, copy, cut, pasteClip]);

  // ---------- panel ----------
  const selected = g.nodes.filter((n) => n.selected);
  const panelNode = selected.length === 1 && selected[0].type !== "note" ? selected[0] : null;

  function addMaskNode(imageNodeId: string, mask: Asset) {
    const source = nodesRef.current.find((n) => n.id === imageNodeId);
    if (!source) return;
    const targets = edgesRef.current.filter((e) => e.source === imageNodeId).map((e) => e.target);
    const pos = freeSpot({ x: source.position.x, y: source.position.y + nodeSize(source).height + 30 }, "image", nodesRef.current);
    const maskId = addNode("image", pos, { data: { asset: mask.id }, to: targets[0] });
    for (const t of targets.slice(1)) connect({ source: maskId, target: t });
    toast(targets.length ? "Mask added as another input image" : "Mask added — connect it to a Generate node");
  }

  async function exportFile() {
    try {
      if (!(await flush())) throw new Error("The workflow couldn't be saved");
      await exportWorkflowFile(workflow.id, name);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function copyWhole() {
    try {
      if (!(await flush())) throw new Error("The workflow couldn't be saved");
      await copyWorkflow(workflow.id);
      toast(`Copied — paste it on the Workflows page with ${shortcut("V")} to make a copy`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  const lightboxOutputs = lightbox ? states?.[lightbox.nodeId]?.outputs ?? [] : [];
  const currentRunning = !!latest?.current && states?.[latest.current.nodeId]?.status === "running";
  const progressText = latest
    ? `${latest.status === "queued" ? "In queue" : "Running"} · ${latest.done} of ${plural(latest.total, "image")}` +
      (currentRunning && latest.current ? ` · ${stepLabel(latest.current.step, latest.current.steps)}` : "")
    : "";
  const progress = latestRun ? runProgress(latestRun) : latest?.progress ?? 0;

  return (
    <div className={s.frame}>
      <header className={s.topbar}>
        <IconButton label="Back to workflows" onClick={() => navigate("/workflows")}>
          <ArrowLeft size={18} />
        </IconButton>
        <input
          className={s.nameInput}
          value={name}
          aria-label="Workflow name"
          size={Math.max(8, Math.min(40, name.length + 1))}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          onBlur={() => !name.trim() && setName("Untitled workflow")}
        />
        <span className={cx(s.saveState, saveState === "error" && s.saveError)} aria-live="polite">
          {saveState === "saving" ? (
            <>
              <Spinner size={12} /> Saving…
            </>
          ) : saveState === "error" ? (
            <>
              <AlertTriangle size={13} /> Not saved — retrying on the next change
            </>
          ) : (
            <>
              <Check size={13} /> Saved
            </>
          )}
        </span>
        <span className={s.grow} />
        <IconButton label={`Undo (${shortcut("Z")})`} onClick={g.undo} disabled={!g.canUndo}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label={`Redo (${isMac ? "⇧⌘Z" : "Ctrl+Y"})`} onClick={g.redo} disabled={!g.canRedo}>
          <Redo2 size={17} />
        </IconButton>
        <IconButton ref={moreMenu.anchor} label="More" active={moreMenu.open} onClick={moreMenu.toggle}>
          <MoreHorizontal size={18} />
        </IconButton>
        <Popover anchor={moreMenu.anchor} open={moreMenu.open} onClose={moreMenu.close} placement="bottom-end" width={230}>
          <Menu
            onDone={moreMenu.close}
            items={[
              { label: "Export file…", icon: <FileDown size={16} />, onSelect: () => void exportFile() },
              { label: "Copy workflow", icon: <Copy size={16} />, onSelect: () => void copyWhole() },
            ]}
          />
        </Popover>
        <span className={s.divider} />
        <FolderPicker prefix="Saving to" value={folder} onChange={setFolder} />
        {active && latest && (
          <button type="button" className={s.runPill} onClick={() => navigate(`/runs/${latest.id}`)} title="Open the run">
            <ProgressRing size={18} stroke={2.5} value={latest.status === "running" ? progress : undefined} />
            {progressText}
          </button>
        )}
        <Button variant="primary" icon={<Play size={15} fill="currentColor" />} shortcut={shortcut("Enter")} onClick={run} loading={starting}>
          Run
        </Button>
      </header>

      <div className={s.body}>
        <div
          ref={wrapper}
          className={cx(s.canvas, filesOver && s.dropping)}
          onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
          onPointerLeave={() => (pointer.current = null)}
          {...dropHandlers}
        >
          <FlowContext.Provider value={ctx}>
            <ReactFlow
              nodes={g.nodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              colorMode={theme}
              onNodesChange={g.onNodesChange}
              onEdgesChange={g.onEdgesChange}
              onConnect={connect}
              onConnectEnd={onConnectEnd}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              reconnectRadius={18}
              connectionRadius={34}
              isValidConnection={isValidConnection}
              onNodeDragStart={g.onNodeDragStart}
              onPaneClick={() => setDropMenu(null)}
              deleteKeyCode={["Backspace", "Delete"]}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnDrag={[1, 2]}
              panOnScroll
              panActivationKeyCode="Space"
              multiSelectionKeyCode={["Meta", "Control", "Shift"]}
              zoomOnDoubleClick={false}
              fitView
              fitViewOptions={FIT_VIEW}
              minZoom={0.2}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_VIEW} />
            </ReactFlow>
          </FlowContext.Provider>
          {g.nodes.length === 0 && <div className={s.toolbarHint}>Add a node below — or drop images here</div>}
          <div className={s.toolbar} role="toolbar" aria-label="Add nodes">
            <Button size="sm" variant="ghost" icon={<ImagePlus size={16} />} onClick={() => addFromToolbar("image")}>
              Image
            </Button>
            <Button size="sm" variant="ghost" icon={<Sparkles size={16} />} onClick={() => addFromToolbar("generate")}>
              Generate
            </Button>
            <Button size="sm" variant="ghost" icon={<Scissors size={16} />} onClick={() => addFromToolbar("removeBackground")}>
              Remove background
            </Button>
            <Button size="sm" variant="ghost" icon={<StickyNote size={16} />} onClick={() => addFromToolbar("note")}>
              Note
            </Button>
          </div>
          {g.nodes.length > 0 && !panelNode && (
            <div className={s.canvasHint} aria-hidden>
              Drag to select · Space-drag or scroll to move · {isMac ? "⌘" : "Ctrl"}+scroll to zoom
            </div>
          )}
        </div>
        {panelNode && (
          <NodePanel
            key={panelNode.id}
            node={panelNode as FlowNode}
            nodes={g.nodes}
            edges={g.edges}
            workflowFolder={folder}
            states={states}
            onChange={g.updateData}
            onClose={() => g.selectOnly(null)}
            onDelete={(nid) => g.removeNodes([nid])}
            onDuplicate={g.duplicateSelected}
            onMask={addMaskNode}
            onRun={run}
          />
        )}
      </div>

      {dropMenu && <DropMenu state={dropMenu} onPick={pickFromDropMenu} onClose={() => setDropMenu(null)} />}
      <OutputLightbox
        outputs={lightboxOutputs}
        index={lightbox && lightboxOutputs.length ? lightbox.index : null}
        onIndex={(i) => setLightbox(i === null || !lightbox ? null : { ...lightbox, index: i })}
        onRemoved={onRemoved}
      />
    </div>
  );
}
