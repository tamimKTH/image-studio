// Node cards for the workflow canvas, used by the editor and the read-only run view.
import "@xyflow/react/dist/style.css";
import { createContext, memo, useContext, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Handle, NodeResizer, Position, useNodes, type NodeProps } from "@xyflow/react";
import { AlertCircle, Check, Clock, ImagePlus, Scissors, Sparkles, StickyNote, Wand2 } from "lucide-react";
import type { Asset, NodeState, NoteColor } from "../lib/api";
import { usePreview } from "../lib/events";
import { uploadImages } from "../components/composer/ImageStrip";
import { stepLabel } from "../components/media/ImageCard";
import { ProgressRing, Spinner, cx, toast } from "../components/ui";
import { rememberAsset, useAsset } from "./assets";
import { NOTE_COLORS, nodeTitle, type GenerateFlowNode, type ImageFlowNode, type NoteFlowNode, type RemoveBgFlowNode } from "./graph";
import s from "./flow.module.css";

export interface FlowContextValue {
  readOnly: boolean;
  /** The run whose states are shown on the nodes (latest run in the editor, the run in the run view). */
  runId: string | null;
  states: Record<string, NodeState> | null;
  /** Show finished/queued rings too (run view); the editor only highlights running and failed nodes. */
  showAllStates: boolean;
  onImageAsset?: (nodeId: string, asset: Asset) => void;
  onOpenOutputs?: (nodeId: string) => void;
  onNoteChange?: (nodeId: string, patch: { text?: string; color?: NoteColor }) => void;
}

export const FlowContext = createContext<FlowContextValue>({ readOnly: false, runId: null, states: null, showAllStates: false });

function useNodeRun(id: string) {
  const ctx = useContext(FlowContext);
  const state = ctx.states?.[id];
  const preview = usePreview(ctx.runId ?? undefined, id);
  return { ctx, state, preview };
}

function statusClass(state: NodeState | undefined, all: boolean): string | undefined {
  if (!state) return undefined;
  switch (state.status) {
    case "running":
      return s.running;
    case "failed":
      return s.failedNode;
    case "done":
      return all ? s.doneNode : undefined;
    case "queued":
      return all ? s.queuedNode : undefined;
    case "skipped":
    case "canceled":
      return all ? s.skippedNode : undefined;
    default:
      return undefined;
  }
}

interface CardProps {
  id: string;
  type: string;
  selected: boolean;
  icon: ReactNode;
  input?: boolean;
  output?: boolean;
  state?: NodeState;
  children: ReactNode;
}

function NodeCard({ id, type, selected, icon, input, output, state, children }: CardProps) {
  const { ctx } = useNodeRun(id);
  const nodes = useNodes();
  const title = nodeTitle({ id, type }, nodes);
  return (
    <div className={cx(s.node, selected && s.selected, statusClass(state, ctx.showAllStates))} data-type={type}>
      <div className={s.nodeHeader}>
        <span className={cx(s.nodeIcon, s[`icon_${type}`])}>{icon}</span>
        <span className={s.nodeTitle}>{title}</span>
        <StatusBadge state={state} all={ctx.showAllStates} />
      </div>
      {children}
      {input && (
        <Handle
          type="target"
          position={Position.Left}
          className={cx(s.handle, ctx.readOnly && s.handleStatic)}
          isConnectable={!ctx.readOnly}
          title={ctx.readOnly ? undefined : "Input — drag a connection here"}
        />
      )}
      {output && (
        <Handle
          type="source"
          position={Position.Right}
          className={cx(s.handle, ctx.readOnly && s.handleStatic)}
          isConnectable={!ctx.readOnly}
          title={ctx.readOnly ? undefined : "Output — drag to connect it to the next step"}
        />
      )}
    </div>
  );
}

function StatusBadge({ state, all }: { state?: NodeState; all: boolean }) {
  if (!state) return null;
  if (state.status === "running") {
    const sampling = state.steps > 0 && state.step < state.steps;
    return (
      <span className={s.badgeRunning} title={stepLabel(state.step, state.steps)}>
        <ProgressRing size={16} stroke={2.5} value={sampling ? state.step / state.steps : undefined} />
      </span>
    );
  }
  if (state.status === "failed")
    return (
      <span className={s.badgeFailed} title={state.error ?? "Failed"}>
        <AlertCircle size={15} />
      </span>
    );
  if (!all) return null;
  if (state.status === "done")
    return (
      <span className={s.badgeDone} title="Done">
        <Check size={14} />
      </span>
    );
  if (state.status === "queued" || state.status === "waiting")
    return (
      <span className={s.badgeQueued} title={state.status === "queued" ? "In queue" : "Waiting for inputs"}>
        <Clock size={14} />
      </span>
    );
  return null;
}

/**
 * The fixed-size result area of a node that makes images: placeholder, queue state,
 * live preview with its step, error, or the last result. It never changes the card's size.
 */
function Result({ id, state, preview, emptyHint }: { id: string; state?: NodeState; preview?: string; emptyHint: ReactNode }) {
  const { ctx } = useNodeRun(id);
  const outputs = state?.outputs ?? [];
  if (state?.status === "running")
    return (
      <div className={cx(s.result, "checker")}>
        {preview ? (
          <img src={preview} alt="" className={s.previewImg} />
        ) : (
          <div className={s.resultHint}>
            <ProgressRing size={18} stroke={2.5} value={state.steps && state.step < state.steps ? state.step / state.steps : undefined} />
            {stepLabel(state.step, state.steps)}
          </div>
        )}
        {preview && <span className={s.stepPill}>{stepLabel(state.step, state.steps)}</span>}
      </div>
    );
  if (state?.status === "failed")
    return (
      <div className={cx(s.result, s.resultError)} title={state.error ?? undefined}>
        <AlertCircle size={16} />
        <span>{state.error || "This step failed."}</span>
      </div>
    );
  if (outputs.length)
    return (
      <button type="button" className={cx(s.result, s.resultButton, "checker", "nodrag")} onClick={() => ctx.onOpenOutputs?.(id)} title="Open result">
        <img src={outputs[0].thumb} alt="Result" />
        {outputs.length > 1 && <span className={s.morePill}>+{outputs.length - 1}</span>}
      </button>
    );
  const text =
    state?.status === "skipped"
      ? "Skipped — an input failed"
      : state?.status === "canceled"
        ? "Canceled"
        : state?.status === "queued"
          ? "In queue"
          : state?.status === "waiting"
            ? "Waiting for inputs"
            : emptyHint;
  return (
    <div className={cx(s.result, s.resultEmpty)}>
      {(state?.status === "queued" || state?.status === "waiting") && <Clock size={15} />}
      <span>{text}</span>
    </div>
  );
}

// ---------- Image ----------
export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps<ImageFlowNode>) {
  const { ctx, state } = useNodeRun(id);
  const asset = useAsset(data.asset);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const editable = !ctx.readOnly && !!ctx.onImageAsset;

  async function accept(files: FileList | File[]) {
    setBusy(true);
    try {
      const [first] = await uploadImages(files);
      if (first) {
        rememberAsset(first);
        ctx.onImageAsset?.(id, first);
      } else toast("That file isn't an image", { tone: "error" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const dropProps = editable
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void accept(e.dataTransfer.files);
        },
      }
    : {};

  return (
    <NodeCard id={id} type="image" selected={selected} icon={<ImagePlus size={15} />} output state={state}>
      <div className={cx(s.imageBox, "checker", over && s.dropOver)} {...dropProps}>
        {busy ? (
          <div className={s.resultHint}>
            <Spinner /> Uploading…
          </div>
        ) : asset ? (
          <img src={asset.thumb} alt={asset.name} draggable={false} />
        ) : data.asset ? (
          <div className={s.resultHint}>
            <Spinner />
          </div>
        ) : editable ? (
          <button type="button" className={cx(s.dropHint, "nodrag")} onClick={() => fileInput.current?.click()}>
            <ImagePlus size={22} />
            <span>Drop an image</span>
            <span className={s.dropSub}>or click to choose</span>
          </button>
        ) : (
          <div className={s.resultHint}>No image</div>
        )}
      </div>
      <div className={s.imageMeta}>
        <span className={s.ellipsis}>{asset ? asset.name : " "}</span>
        {asset && (
          <span>
            {asset.width}×{asset.height}
          </span>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void accept(e.target.files);
          e.target.value = "";
        }}
      />
    </NodeCard>
  );
});

// ---------- Generate ----------
function aspectLabel(data: GenerateFlowNode["data"]): string {
  if (data.aspect === "auto") return data.inputs.length ? "Match 1" : "1:1";
  return data.aspect;
}

export const GenerateNode = memo(function GenerateNode({ id, data, selected }: NodeProps<GenerateFlowNode>) {
  const { state, preview } = useNodeRun(id);
  return (
    <NodeCard id={id} type="generate" selected={selected} icon={<Sparkles size={15} />} input output state={state}>
      {data.prompt.trim() ? (
        <p className={s.prompt}>{data.prompt}</p>
      ) : (
        <p className={cx(s.prompt, s.promptMissing)}>
          <AlertCircle size={14} /> Add a prompt
        </p>
      )}
      <div className={s.miniChips}>
        <span className={s.mini}>{aspectLabel(data)}</span>
        <span className={s.mini}>{data.size === "2k" ? "2K" : "1K"}</span>
        {data.count > 1 && <span className={s.mini}>×{data.count}</span>}
        {data.transparent && <span className={s.mini}>Transparent</span>}
        {data.autoImprove && (
          <span className={cx(s.mini, s.miniAccent)}>
            <Wand2 size={11} /> Auto-improve
          </span>
        )}
        {data.inputs.length > 0 && <span className={s.mini}>{data.inputs.length === 1 ? "1 image" : `${data.inputs.length} images`}</span>}
      </div>
      <Result id={id} state={state} preview={preview} emptyHint="The result appears here" />
    </NodeCard>
  );
});

// ---------- Remove background ----------
export const RemoveBackgroundNode = memo(function RemoveBackgroundNode({ id, selected }: NodeProps<RemoveBgFlowNode>) {
  const { state, preview } = useNodeRun(id);
  return (
    <NodeCard id={id} type="removeBackground" selected={selected} icon={<Scissors size={15} />} input output state={state}>
      <Result id={id} state={state} preview={preview} emptyHint="Cuts out the subject into a transparent PNG" />
    </NodeCard>
  );
});

// ---------- Note ----------
const NOTE_LABEL: Record<NoteColor, string> = { yellow: "Yellow", blue: "Blue", green: "Green", pink: "Pink", gray: "Gray" };

/** A sticky note: never runs, no connections. Type in it, pick a colour, drag a corner to resize. */
export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps<NoteFlowNode>) {
  const ctx = useContext(FlowContext);
  const editable = !ctx.readOnly && !!ctx.onNoteChange;
  return (
    <div className={cx(s.note, s[`note_${data.color}`], selected && editable && s.noteSelected)} data-type="note">
      {editable && (
        <NodeResizer
          isVisible={selected}
          minWidth={160}
          minHeight={96}
          lineClassName={s.resizeLine}
          handleClassName={s.resizeHandle}
        />
      )}
      <div className={s.noteHeader} title={editable ? "Drag to move" : undefined}>
        <StickyNote size={13} />
        <span className={s.noteLabel}>Note</span>
        {editable && selected && (
          <span className={cx(s.swatches, "nodrag")} role="radiogroup" aria-label="Note colour">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={data.color === c}
                aria-label={NOTE_LABEL[c]}
                title={NOTE_LABEL[c]}
                className={cx(s.swatch, s[`note_${c}`], data.color === c && s.swatchOn)}
                onClick={() => ctx.onNoteChange?.(id, { color: c })}
              />
            ))}
          </span>
        )}
      </div>
      {editable ? (
        <textarea
          className={cx(s.noteText, "nodrag", "nowheel")}
          value={data.text}
          placeholder="Write a note…"
          aria-label="Note text"
          onChange={(e) => ctx.onNoteChange?.(id, { text: e.target.value })}
        />
      ) : (
        <div className={cx(s.noteText, s.noteRead, "nowheel")}>{data.text || <span className={s.noteEmpty}>Empty note</span>}</div>
      )}
    </div>
  );
});

/** Stable node-type map for <ReactFlow nodeTypes>. */
export const nodeTypes = {
  image: ImageNode,
  generate: GenerateNode,
  removeBackground: RemoveBackgroundNode,
  note: NoteNode,
};
