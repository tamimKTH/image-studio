import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type OnConnectEnd,
} from "@xyflow/react";
import { AlertTriangle, ArrowLeft, Check, ImagePlus, Play, Redo2, Scissors, Sparkles, Undo2 } from "lucide-react";
import { api, type Asset, type NodeType, type Workflow } from "../lib/api";
import { useRun, useRunList } from "../lib/events";
import { uploadImages } from "../components/composer/ImageStrip";
import { FolderPicker } from "../components/folders/FolderPicker";
import { Button, Empty, IconButton, ProgressRing, Spinner, cx, toast } from "../components/ui";
import { rememberAsset } from "../flow/assets";
import { DropMenu, type DropMenuState } from "../flow/DropMenu";
import { NODE_WIDTH, freeSpot, fromFlow, nodeHeight, validate, type FlowNode } from "../flow/graph";
import { NodePanel } from "../flow/NodePanel";
import { FlowContext, nodeTypes, type FlowContextValue } from "../flow/nodes";
import { OutputLightbox } from "../flow/OutputLightbox";
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

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function Editor({ workflow }: { workflow: Workflow }) {
  const navigate = useNavigate();
  const g = useGraph(workflow.graph);
  const { updateData, undo, redo, duplicateSelected, selectOnly, addNode, nodesRef, edgesRef } = g;
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(workflow.name);
  const [folder, setFolder] = useState<string | null>(workflow.folder);
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null);
  const [lightbox, setLightbox] = useState<{ nodeId: string; index: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [filesOver, setFilesOver] = useState(false);

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
    if (payload === savedRef.current) return;
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
  const states = latestRun?.nodes ?? null;

  const setImageAsset = useCallback((nodeId: string, asset: Asset) => updateData(nodeId, { asset: asset.id }), [updateData]);
  const ctx = useMemo<FlowContextValue>(
    () => ({
      readOnly: false,
      runId: latest?.id ?? null,
      states,
      showAllStates: false,
      onImageAsset: setImageAsset,
      onOpenOutputs: (nodeId) => setLightbox({ nodeId, index: 0 }),
    }),
    [latest?.id, states, setImageAsset],
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
    const selected = g.nodesRef.current.filter((n) => n.selected);
    if (type !== "image" && selected.length === 1) {
      const from = selected[0];
      const pos = freeSpot({ x: from.position.x + NODE_WIDTH + 90, y: from.position.y }, type, g.nodesRef.current);
      g.addNode(type, pos, { from: from.id });
      // Keep the new node and the node it continues from in view.
      const x = (from.position.x + pos.x + NODE_WIDTH) / 2;
      const y = (from.position.y + pos.y + nodeHeight(type)) / 2;
      flow.setCenter(x, y, { zoom: flow.getZoom(), duration: 300 });
      return;
    }
    const c = viewCenter();
    g.addNode(type, freeSpot({ x: c.x - NODE_WIDTH / 2, y: c.y - nodeHeight(type) / 2 }, type, g.nodesRef.current));
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

  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    // Dropped on empty canvas: no valid connection and no handle under the pointer.
    if (state.isValid || !state.fromNode || state.toHandle) return;
    const { clientX, clientY } = "changedTouches" in event ? event.changedTouches[0] : event;
    setDropMenu({ x: clientX, y: clientY, nodeId: state.fromNode.id, handle: state.fromHandle?.type === "target" ? "target" : "source" });
  }, []);

  function pickFromDropMenu(type: NodeType) {
    if (!dropMenu) return;
    const p = flow.screenToFlowPosition({ x: dropMenu.x, y: dropMenu.y });
    const y = p.y - 60;
    if (dropMenu.handle === "source") g.addNode(type, { x: p.x, y }, { from: dropMenu.nodeId });
    else g.addNode(type, { x: p.x - NODE_WIDTH, y }, { to: dropMenu.nodeId });
    setDropMenu(null);
  }

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
    const problem = validate(nodesRef.current, edgesRef.current);
    if (problem) {
      toast(problem.message, { tone: "error" });
      if (problem.nodeId) selectOnly(problem.nodeId);
      return;
    }
    setStarting(true);
    try {
      if (!(await flush())) throw new Error("The workflow couldn't be saved");
      const { runId } = await api.runWorkflow(workflow.id);
      toast("Running — it keeps going in the background", { action: { label: "View", onClick: () => navigate(`/runs/${runId}`) } });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setStarting(false);
    }
  }, [nodesRef, edgesRef, selectOnly, flush, workflow.id, navigate]);

  // ---------- keyboard and paste ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void run();
        return;
      }
      if (e.key === "Escape" && !document.querySelector('[aria-modal="true"], [role="dialog"]')) {
        (document.activeElement as HTMLElement | null)?.blur();
        selectOnly(null);
        return;
      }
      if (isTyping(e.target)) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
      }
    };
    const onPaste = async (e: ClipboardEvent) => {
      if (isTyping(e.target) || !e.clipboardData?.files.length) return;
      e.preventDefault();
      try {
        const assets = await uploadImages(e.clipboardData.files);
        if (assets.length) addImages(assets);
      } catch (err) {
        toast((err as Error).message, { tone: "error" });
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, [undo, redo, duplicateSelected, selectOnly, run, addImages]);

  // ---------- panel ----------
  const selected = g.nodes.filter((n) => n.selected);
  const panelNode = selected.length === 1 ? selected[0] : null;

  function addMaskNode(imageNodeId: string, mask: Asset) {
    const source = g.nodesRef.current.find((n) => n.id === imageNodeId);
    if (!source) return;
    const targets = g.edgesRef.current.filter((e) => e.source === imageNodeId).map((e) => e.target);
    const pos = freeSpot({ x: source.position.x, y: source.position.y + nodeHeight("image") + 30 }, "image", g.nodesRef.current);
    const maskId = g.addNode("image", pos, { data: { asset: mask.id }, to: targets[0] });
    for (const t of targets.slice(1)) g.onConnect({ source: maskId, target: t, sourceHandle: null, targetHandle: null });
    toast(targets.length ? "Mask added as another input image" : "Mask added — connect it to a Generate node");
  }

  const lightboxOutputs = lightbox ? states?.[lightbox.nodeId]?.outputs ?? [] : [];
  const progressText = latest
    ? `${latest.status === "queued" ? "In queue" : "Running"} · ${latest.done} of ${latest.total}` +
      (latest.current?.steps ? ` · Step ${latest.current.step} of ${latest.current.steps}` : "")
    : "";

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
        <IconButton label="Undo (⌘Z)" onClick={g.undo} disabled={!g.canUndo}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label="Redo (⇧⌘Z)" onClick={g.redo} disabled={!g.canRedo}>
          <Redo2 size={17} />
        </IconButton>
        <span className={s.divider} />
        <FolderPicker prefix="Saving to" value={folder} onChange={setFolder} />
        {active && latest && (
          <button type="button" className={s.runPill} onClick={() => navigate(`/runs/${latest.id}`)} title="Open the run">
            <ProgressRing size={18} stroke={2.5} value={latest.progress || undefined} />
            {progressText}
          </button>
        )}
        <Button variant="primary" icon={<Play size={15} fill="currentColor" />} shortcut="⌘↵" onClick={run} loading={starting}>
          Run
        </Button>
      </header>

      <div className={s.body}>
        <div ref={wrapper} className={cx(s.canvas, filesOver && s.dropping)} {...dropHandlers}>
          <FlowContext.Provider value={ctx}>
            <ReactFlow
              nodes={g.nodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              onNodesChange={g.onNodesChange}
              onEdgesChange={g.onEdgesChange}
              onConnect={g.onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={g.isValidConnection}
              onNodeDragStart={g.onNodeDragStart}
              onPaneClick={() => setDropMenu(null)}
              deleteKeyCode={["Backspace", "Delete"]}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
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
          </div>
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
      />
    </div>
  );
}
