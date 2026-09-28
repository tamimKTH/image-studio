import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, type Edge } from "@xyflow/react";
import { AlertTriangle, ArrowLeft, Pencil, RotateCcw, Square } from "lucide-react";
import { api, type OutputImage, type RunDetail, type RunStatus } from "../lib/api";
import { useRun } from "../lib/events";
import { duration, plural } from "../lib/format";
import { useResolvedTheme } from "../lib/prefs";
import { stepLabel } from "../components/media/ImageCard";
import { runAgain as startAgain, runAgainLabel } from "../components/media/RunResults";
import { Button, Empty, IconButton, Spinner, cx, toast } from "../components/ui";
import { runProgress, toFlowEdges, toFlowNodes, topoOrder } from "../flow/graph";
import { FlowContext, nodeTypes, type FlowContextValue } from "../flow/nodes";
import { OutputLightbox, useDeletedOutputs } from "../flow/OutputLightbox";
import { CreateRunView } from "./CreateRun";
import s from "../flow/flow.module.css";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "In queue",
  running: "Running",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

export function RunView() {
  const { id } = useParams();
  const { run, error } = useRun(id);

  if (error)
    return (
      <div className={s.center}>
        <Empty
          icon={<AlertTriangle size={24} />}
          title="This run can't be found"
          text={error}
          action={
            <Link to="/activity">
              <Button>Go to Activity</Button>
            </Link>
          }
        />
      </div>
    );
  if (!run)
    return (
      <div className={s.center}>
        <Spinner size={22} />
      </div>
    );
  if (run.kind === "create") return <CreateRunView run={run} />;
  return (
    <ReactFlowProvider>
      <WorkflowRun key={run.id} run={run} />
    </ReactFlowProvider>
  );
}

/** Seconds since the run started, ticking while it is active. */
function useElapsed(run: RunDetail): number {
  const active = run.status === "queued" || run.status === "running";
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!run.startedAt) return 0;
  return (run.finishedAt ?? (active ? now : run.startedAt)) - run.startedAt;
}

function WorkflowRun({ run }: { run: RunDetail }) {
  const navigate = useNavigate();
  const active = run.status === "queued" || run.status === "running";
  const elapsed = useElapsed(run);
  const theme = useResolvedTheme();
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<{ outputs: OutputImage[]; index: number } | null>(null);
  const { hide, onRemoved } = useDeletedOutputs();
  const states = useMemo(() => hide(run.nodes) ?? {}, [hide, run.nodes]);

  const nodes = useMemo(() => toFlowNodes(run.graph.nodes), [run.graph]);
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(run.graph.nodes.map((n) => [n.id, n]));
    return toFlowEdges(run.graph.edges).map((e) => {
      const target = byId.get(e.target);
      const inputs = target?.type === "generate" ? (target.data as { inputs: string[] }).inputs : [];
      const index = inputs.indexOf(e.source);
      return {
        ...e,
        label: index >= 0 ? String(index + 1) : undefined,
        labelBgPadding: [7, 3] as [number, number],
        labelBgBorderRadius: 9,
        labelStyle: { fill: "var(--text-2)", fontWeight: 700, fontSize: 11 },
        labelBgStyle: { fill: "var(--surface)", stroke: "var(--border-strong)" },
        animated: run.nodes[e.target]?.status === "running",
      };
    });
  }, [run.graph, run.nodes]);

  // All results, inputs before the images made from them.
  const outputs = useMemo(
    () => topoOrder(run.graph).flatMap((nid) => (run.graph.nodes.find((n) => n.id === nid)?.type === "image" ? [] : states[nid]?.outputs ?? [])),
    [run.graph, states],
  );

  const ctx = useMemo<FlowContextValue>(
    () => ({
      readOnly: true,
      runId: run.id,
      states,
      showAllStates: true,
      onOpenOutputs: (nodeId) => {
        const list = states[nodeId]?.outputs ?? [];
        if (list.length) setLightbox({ outputs: list, index: 0 });
      },
    }),
    [run.id, states],
  );

  async function cancel() {
    setBusy(true);
    try {
      await api.cancelRun(run.id);
      toast("Stopping the run…");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  // A finished run starts over; a failed or canceled one resumes, keeping the images it made.
  async function runAgain() {
    setBusy(true);
    try {
      const runId = await startAgain(run);
      navigate(`/runs/${runId}`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const progress = runProgress(run);
  // The step belongs to the node that is running now; once it is done, no stale step is shown.
  const current = active && run.current && run.nodes[run.current.nodeId]?.status === "running" ? run.current : null;
  const detail =
    `${run.done} of ${plural(run.total, "image")}` +
    (current ? ` · ${stepLabel(current.step, current.steps)}` : "") +
    (elapsed ? ` · ${duration(elapsed)}` : "");

  return (
    <div className={s.frame}>
      <header className={s.topbar}>
        <IconButton label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/activity"))}>
          <ArrowLeft size={18} />
        </IconButton>
        <div className={s.runHead}>
          <div className={s.runTitleRow}>
            <span className={s.runName}>{run.name}</span>
            {run.number ? <span className={s.runNumber}>Run {run.number}</span> : null}
            <span className={cx(s.statusChip, s[`st_${run.status}`])}>{STATUS_LABEL[run.status]}</span>
          </div>
          <div className={s.progressRow}>
            <div className={s.progressTrack} role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={cx(s.progressBar, run.status === "done" && s.progressDone, run.status === "failed" && s.progressFailed)}
                style={{ width: `${Math.max(active ? 3 : 0, progress * 100)}%` }}
              />
            </div>
            <span>{detail}</span>
          </div>
        </div>
        {run.workflowId && (
          <Button icon={<Pencil size={15} />} onClick={() => navigate(`/workflows/${run.workflowId}`)}>
            Open workflow
          </Button>
        )}
        {active ? (
          <Button icon={<Square size={14} fill="currentColor" />} onClick={cancel} loading={busy}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={<RotateCcw size={15} />} onClick={runAgain} loading={busy} title={runAgainLabel(run).title}>
            {runAgainLabel(run).label}
          </Button>
        )}
      </header>

      {run.error && <div className={s.runError} style={{ marginTop: 12 }}>{run.error}</div>}

      <div className={s.body}>
        <div className={s.canvas}>
          <FlowContext.Provider value={ctx}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode={theme}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              onNodeClick={(_, node) => ctx.onOpenOutputs?.(node.id)}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--canvas-dot)" />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          </FlowContext.Provider>
        </div>
      </div>

      <div className={s.strip} aria-label="Results">
        <span className={s.stripLabel}>{outputs.length ? plural(outputs.length, "result") : active ? "Results appear here" : "No results"}</span>
        {outputs.map((o, i) => (
          <button key={o.id} type="button" className={cx(s.stripItem, "checker")} onClick={() => setLightbox({ outputs, index: i })} title={o.name}>
            {/* A result moved or deleted outside this page leaves the list. */}
            <img src={o.thumb} alt={o.name} onError={() => onRemoved(o.path, true)} />
          </button>
        ))}
      </div>

      <OutputLightbox
        outputs={lightbox?.outputs ?? []}
        index={lightbox ? lightbox.index : null}
        onIndex={(i) => setLightbox(i === null || !lightbox ? null : { ...lightbox, index: i })}
        onRemoved={onRemoved}
      />
    </div>
  );
}
