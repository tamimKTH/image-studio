// Image slots for Create runs: what each run is expected to produce, live progress, and actions on results.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  type Asset,
  type Aspect,
  type GenerateNodeData,
  type NodeState,
  type NodeStatus,
  type OutputImage,
  type RunDetail,
  type RunStatus,
  type RunSummary,
} from "../../lib/api";
import { useLive, usePreview } from "../../lib/events";
import { timeAgo } from "../../lib/format";
import { toast } from "../ui";
import { ImageCard } from "./ImageCard";
import s from "./runResults.module.css";

export const isActive = (status: RunStatus) => status === "queued" || status === "running";

const RATIO: Record<Exclude<Aspect, "auto">, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "3:2": 3 / 2,
  "2:3": 2 / 3,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

const suffix = (id: string) => Number(id.replace(/\D+/g, "")) || 0;

/** The node that makes the images of a Create run: "gen", or "cut" for Remove background. */
export function workNodeId(run: RunDetail | undefined): "gen" | "cut" {
  return run?.graph.nodes.some((n) => n.id === "cut") ? "cut" : "gen";
}

export function generateData(run: RunDetail | undefined): GenerateNodeData | null {
  const node = run?.graph.nodes.find((n) => n.type === "generate");
  return node ? (node.data as GenerateNodeData) : null;
}

/** Input images of a Create run in their numbered order (image 1, image 2, …). */
export function runInputs(run: RunDetail | undefined): OutputImage[] {
  if (!run) return [];
  const gen = generateData(run);
  const imageIds = run.graph.nodes.filter((n) => n.type === "image").map((n) => n.id);
  const ordered = gen?.inputs?.length
    ? [...gen.inputs.filter((id) => imageIds.includes(id)), ...imageIds.filter((id) => !gen.inputs.includes(id))]
    : [...imageIds].sort((a, b) => suffix(a) - suffix(b));
  return ordered.map((id) => run.nodes[id]?.outputs?.[0]).filter((o): o is OutputImage => !!o);
}

/** "1K · 16:9 · ×2 · Transparent", or "Remove background". */
export function settingsSummary(run: RunDetail | undefined): string {
  if (!run) return "";
  if (workNodeId(run) === "cut") return "Remove background";
  const g = generateData(run);
  if (!g) return "";
  const hasInputs = runInputs(run).length > 0;
  const aspect = g.aspect === "auto" ? (hasInputs ? "Matches image 1" : "1:1") : g.aspect;
  return [
    g.size === "2k" ? "2K" : "1K",
    aspect,
    g.count > 1 ? `×${g.count}` : null,
    g.transparent ? "Transparent" : null,
    g.quality === "fast" ? "Fast" : g.quality === "best" ? "Best quality" : null,
    hasInputs ? `${runInputs(run).length} input${runInputs(run).length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface Slot {
  key: string;
  state: NodeStatus;
  output?: OutputImage;
  step: number;
  steps: number;
  error: string | null;
}

/** One slot per expected image: finished ones carry their output, the next one runs, the rest wait. */
export function runSlots(summary: RunSummary, detail: RunDetail | undefined): Slot[] {
  const nodeId = workNodeId(detail);
  const node: Partial<NodeState> | undefined = detail?.nodes[nodeId];
  const outputs = node?.outputs?.length ? node.outputs : summary.outputs;
  const expected = nodeId === "cut" ? 1 : generateData(detail)?.count ?? 1;
  const count = Math.max(expected, outputs.length, 1);
  const slots: Slot[] = [];
  for (let k = 0; k < count; k++) {
    const key = `${summary.id}-${k}`;
    if (k < outputs.length) {
      slots.push({ key, state: "done", output: outputs[k], step: 0, steps: 0, error: null });
      continue;
    }
    if (isActive(summary.status)) {
      const running = summary.status === "running" && k === outputs.length && (node?.status ?? "running") === "running";
      const step = node?.step ?? summary.current?.step ?? 0;
      const steps = node?.steps ?? summary.current?.steps ?? 0;
      slots.push({ key, state: running ? "running" : node?.status === "waiting" ? "waiting" : "queued", step, steps, error: null });
      continue;
    }
    const failed = node?.status === "failed" || summary.status === "failed";
    slots.push({
      key,
      state: failed ? "failed" : summary.status === "canceled" ? "canceled" : "skipped",
      step: 0,
      steps: 0,
      error: node?.error ?? summary.error,
    });
  }
  return slots;
}

/** Short status for a run header: "In queue", "Image 2 of 4 · Step 12 of 28", "Failed — …", "3 min ago". */
export function runStatusText(summary: RunSummary, detail: RunDetail | undefined): { text: string; tone: "running" | "failed" | "normal" } {
  if (summary.status === "queued") return { text: "In queue", tone: "running" };
  if (summary.status === "running") {
    const slots = runSlots(summary, detail);
    const index = slots.findIndex((sl) => sl.state === "running");
    if (index < 0) return { text: "In queue", tone: "running" };
    const current = slots[index];
    const step = current.steps ? `Step ${current.step} of ${current.steps}` : "Loading the model…";
    return { text: slots.length > 1 ? `Image ${index + 1} of ${slots.length} · ${step}` : step, tone: "running" };
  }
  if (summary.status === "failed") return { text: `Failed${summary.error ? ` — ${summary.error}` : ""}`, tone: "failed" };
  if (summary.status === "canceled") return { text: "Canceled", tone: "normal" };
  return { text: timeAgo(summary.finishedAt ?? summary.createdAt), tone: "normal" };
}

/** Expected width / height before an image exists. */
export function expectedRatio(detail: RunDetail | undefined, firstInputRatio: number | undefined): number {
  const g = generateData(detail);
  if (g && g.aspect !== "auto") return RATIO[g.aspect] ?? 1;
  if (runInputs(detail).length) return firstInputRatio ?? 1;
  return 1;
}

const ratioCache = new Map<string, number>();

/** Natural width / height of an image URL (cached). */
export function useImageRatio(url: string | undefined): number | undefined {
  const [ratio, setRatio] = useState<number | undefined>(() => (url ? ratioCache.get(url) : undefined));
  useEffect(() => {
    if (!url) {
      setRatio(undefined);
      return;
    }
    const known = ratioCache.get(url);
    if (known) {
      setRatio(known);
      return;
    }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const r = img.naturalWidth / Math.max(1, img.naturalHeight);
      ratioCache.set(url, r);
      if (alive) setRatio(r);
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return ratio;
}

/**
 * Full details for a list of runs, fetched once each and refreshed when a run finishes,
 * merged with the live node events.
 */
export function useRunDetails(runs: RunSummary[]): Record<string, RunDetail | undefined> {
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const pending = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const liveNodes = useLive((st) => st.nodes);

  useEffect(() => {
    for (const r of runs) {
      const d = details[r.id];
      const stale = d && isActive(d.status) && !isActive(r.status);
      if ((d && !stale) || pending.current.has(r.id) || failed.current.has(r.id)) continue;
      pending.current.add(r.id);
      api
        .run(r.id)
        .then((full) => setDetails((prev) => ({ ...prev, [r.id]: full })))
        .catch(() => failed.current.add(r.id))
        .finally(() => pending.current.delete(r.id));
    }
  }, [runs, details]);

  return useMemo(() => {
    const out: Record<string, RunDetail | undefined> = {};
    for (const r of runs) {
      const d = details[r.id];
      if (!d) continue;
      const nodes = { ...d.nodes };
      for (const [id, patch] of Object.entries(liveNodes[r.id] ?? {})) nodes[id] = { ...nodes[id], ...patch } as NodeState;
      out[r.id] = { ...d, ...r, nodes };
    }
    return out;
  }, [runs, details, liveNodes]);
}

/** Puts a run into the live store right away, before its first server event arrives. */
export async function primeRun(runId: string) {
  try {
    const detail = await api.run(runId);
    useLive.setState((st) => ({ runs: { ...st.runs, [detail.id]: st.runs[detail.id] ?? detail } }));
  } catch {
    /* the event stream delivers it */
  }
}

/** Asset for a result (to use it as an input). */
export async function outputAsset(output: OutputImage): Promise<Asset> {
  try {
    return await api.asset(output.id);
  } catch {
    return api.assetFromPath(output.path);
  }
}

export function downloadFile(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Moves results to the Mac Trash and remembers them so they disappear from the page. */
export function useTrash() {
  const [trashed, setTrashed] = useState<ReadonlySet<string>>(new Set());
  async function trash(path: string): Promise<boolean> {
    try {
      await api.trash(path);
      setTrashed((prev) => new Set(prev).add(path));
      toast("Moved to Trash");
      return true;
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
      return false;
    }
  }
  return { trashed, trash };
}

interface ResultCardProps {
  runId: string;
  nodeId: string;
  slot: Slot;
  /** Expected ratio until the image exists. */
  ratio: number;
  /** Tallest a card may be, in px. */
  maxHeight: number;
  onOpen?: () => void;
  actions?: ReactNode;
}

/** One result slot sized by its image ratio, with the live preview while it forms. */
export function ResultCard({ runId, nodeId, slot, ratio, maxHeight, onOpen, actions }: ResultCardProps) {
  const preview = usePreview(slot.state === "running" ? runId : undefined, nodeId);
  const measured = useImageRatio(slot.output?.thumb);
  const r = measured ?? ratio;
  return (
    <div className={s.slot} style={{ ["--r" as string]: r, ["--maxh" as string]: `${maxHeight}px` }}>
      <ImageCard
        src={slot.output?.thumb}
        preview={preview}
        state={slot.state}
        step={slot.step}
        steps={slot.steps}
        error={slot.error}
        ratio={r}
        onClick={onOpen}
        actions={actions}
        alt={slot.output?.name ?? ""}
      />
    </div>
  );
}

interface ResultRowProps {
  summary: RunSummary;
  detail: RunDetail | undefined;
  /** Tallest a card may be, in px. */
  maxHeight: number;
  trashed: ReadonlySet<string>;
  onOpen: (output: OutputImage) => void;
  cardActions: (output: OutputImage) => ReactNode;
}

/** The images of one run in a justified row (placeholders for the ones still coming). */
export function ResultRow({ summary, detail, maxHeight, trashed, onOpen, cardActions }: ResultRowProps) {
  const inputRatio = useImageRatio(runInputs(detail)[0]?.thumb);
  const ratio = expectedRatio(detail, inputRatio);
  const nodeId = workNodeId(detail);
  const slots = runSlots(summary, detail).filter((sl) => !sl.output || !trashed.has(sl.output.path));
  if (!slots.length) return null;
  return (
    <div className={s.cards}>
      {slots.map((slot) => (
        <ResultCard
          key={slot.key}
          runId={summary.id}
          nodeId={nodeId}
          slot={slot}
          ratio={ratio}
          maxHeight={maxHeight}
          onOpen={slot.output ? () => onOpen(slot.output!) : undefined}
          actions={slot.output ? cardActions(slot.output) : undefined}
        />
      ))}
    </div>
  );
}

/** True when every image of a finished run was moved to the Trash. */
function allTrashed(summary: RunSummary, detail: RunDetail | undefined, trashed: ReadonlySet<string>) {
  const slots = runSlots(summary, detail);
  return slots.length > 0 && slots.every((sl) => sl.output && trashed.has(sl.output.path));
}

interface RunGroupProps extends ResultRowProps {
  headerActions?: ReactNode;
}

/** A run as one block: its prompt, status and settings above, one card per expected image below. */
export function RunGroup({ headerActions, ...row }: RunGroupProps) {
  const { summary, detail, trashed } = row;
  const nodeId = workNodeId(detail);
  const status = runStatusText(summary, detail);
  const prompt = nodeId === "cut" ? "Remove background" : generateData(detail)?.prompt ?? summary.name;
  if (allTrashed(summary, detail, trashed)) return null;
  return (
    <section className={s.group}>
      <div className={s.head}>
        <div className={s.headText}>
          <div className={nodeId === "cut" ? `${s.prompt} ${s.promptMuted}` : s.prompt} title={prompt}>
            {prompt}
          </div>
          <div className={s.meta}>
            <span className={status.tone === "running" ? s.statusRunning : status.tone === "failed" ? s.statusFailed : undefined}>
              {status.text}
            </span>
            {detail && nodeId !== "cut" && <span className={s.metaSep}>{settingsSummary(detail)}</span>}
          </div>
        </div>
        {headerActions && <div className={s.headActions}>{headerActions}</div>}
      </div>
      <ResultRow {...row} />
    </section>
  );
}
