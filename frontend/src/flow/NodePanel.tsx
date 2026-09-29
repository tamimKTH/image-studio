// Settings for the selected node: the same prompt box, options and folder picker as Create.
import { useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { Brush, Copy, GripVertical, Image as ImageIcon, ImagePlus, Scissors, Sparkles, Trash2, X } from "lucide-react";
import type { Asset, GenerateSettings, NodeState, RemoveBackgroundNodeData } from "../lib/api";
import { isMac, shortcut } from "../lib/keys";
import { ImproveButton, PromptBox } from "../components/composer/PromptBox";
import { OptionsBar } from "../components/composer/OptionsBar";
import { MarkArea } from "../components/composer/MarkArea";
import { uploadImages } from "../components/composer/ImageStrip";
import { FolderPicker } from "../components/folders/FolderPicker";
import { Button, IconButton, Segmented, Switch, cx, toast } from "../components/ui";
import { rememberAsset, useAsset } from "./assets";
import { nodeTitle, type FlowNode, type GenerateFlowNode, type ImageFlowNode } from "./graph";
import s from "./flow.module.css";

interface Props {
  node: FlowNode;
  nodes: FlowNode[];
  edges: Edge[];
  /** The workflow's own save folder (null = the app's default folder). */
  workflowFolder: string | null;
  states: Record<string, NodeState> | null;
  onChange: (id: string, patch: Record<string, unknown>, key?: string) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: () => void;
  /** A mask made on an image node: add it as a new image wired to the same targets. */
  onMask: (imageNodeId: string, mask: Asset) => void;
  onRun: () => void;
}

export function NodePanel(props: Props) {
  const { node, nodes, onClose, onDelete, onDuplicate } = props;
  const icon =
    node.type === "image" ? <ImageIcon size={17} /> : node.type === "generate" ? <Sparkles size={17} /> : <Scissors size={17} />;
  return (
    <aside className={s.panel} aria-label="Node settings">
      <div className={s.panelHeader}>
        {icon}
        <div className={s.panelTitle}>{nodeTitle(node, nodes)}</div>
        <IconButton label="Close (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className={s.panelBody}>
        {node.type === "generate" && <GenerateSettingsPanel {...props} node={node} />}
        {node.type === "image" && <ImageSettingsPanel {...props} node={node} />}
        {node.type === "removeBackground" && (
          <>
            <p className={s.muted}>Cuts the main subject out of its input and saves it as a transparent PNG. Connect one image or result into it.</p>
            <div className={s.section}>
              <Segmented
                label="Quality"
                value={(node.data as RemoveBackgroundNodeData).quality ?? "standard"}
                onChange={(quality) => props.onChange(node.id, { quality })}
                options={[
                  { value: "fast", label: "Fast", title: "16 steps" },
                  { value: "standard", label: "Standard", title: "28 steps" },
                  { value: "best", label: "Best", title: "40 steps" },
                ]}
              />
            </div>
            <FolderSection {...props} />
          </>
        )}
      </div>
      <div className={s.panelFooter}>
        <Button size="sm" icon={<Copy size={15} />} onClick={onDuplicate} title={`Duplicate (${shortcut("D")})`}>
          Duplicate
        </Button>
        <span className={s.grow} />
        <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={() => onDelete(node.id)} title={`Delete (${isMac ? "⌫" : "Del"})`}>
          Delete
        </Button>
      </div>
    </aside>
  );
}

// ---------- Generate ----------
function GenerateSettingsPanel({ node, nodes, edges, states, onChange, onRun, ...rest }: Props & { node: GenerateFlowNode }) {
  const data = node.data;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const imageAssets = data.inputs
    .map((i) => byId.get(i))
    .filter((n): n is ImageFlowNode => n?.type === "image" && !!n.data.asset)
    .map((n) => n.data.asset as string);
  const settings: GenerateSettings = {
    aspect: data.aspect,
    size: data.size,
    quality: data.quality,
    count: data.count,
    transparent: data.transparent,
    advanced: data.advanced,
  };
  const set = (patch: Record<string, unknown>, key?: string) => onChange(node.id, patch, key);

  return (
    <>
      <div className={s.section}>
        <div className={s.promptCard}>
          <PromptBox
            value={data.prompt}
            onChange={(prompt) => set({ prompt }, `prompt:${node.id}`)}
            placeholder={
              data.inputs.length
                ? "Describe what to do — e.g. put image 2 on the table in image 1"
                : "Describe the image to create…"
            }
            onSubmit={onRun}
            minHeight={88}
          />
          <div className={s.promptTools}>
            <ImproveButton
              prompt={data.prompt}
              images={imageAssets}
              onChange={(prompt) => set({ prompt })}
              aspect={data.aspect}
              onAspect={(aspect) => set({ aspect })}
            />
          </div>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>
          Input images
          <span className={s.sectionHint}>{data.inputs.length ? "Drag to reorder" : ""}</span>
        </div>
        {data.inputs.length ? (
          <InputList node={node} nodes={nodes} states={states} onReorder={(inputs) => set({ inputs }, "reorder")} />
        ) : (
          <p className={s.muted}>
            Connect images into this node to edit or combine them — or leave it empty to create from the prompt alone.
          </p>
        )}
        {data.inputs.length > 0 && <p className={s.sectionHint}>Write "image 1", "image 2" in the prompt to refer to them.</p>}
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Options</div>
        <OptionsBar
          value={settings}
          hasImages={data.inputs.length > 0}
          onChange={(v) =>
            set({ aspect: v.aspect, size: v.size, quality: v.quality, count: v.count, transparent: v.transparent, advanced: v.advanced }, `options:${node.id}`)
          }
        />
      </div>

      <div className={s.switchRow}>
        <div>
          <div className={s.switchText}>Auto-improve</div>
          <div className={s.switchHint}>Improve the prompt with the input images when the run starts (about 30 s more).</div>
        </div>
        <Switch checked={data.autoImprove} onChange={(autoImprove) => set({ autoImprove })} label="Auto-improve" />
      </div>

      <FolderSection node={node} nodes={nodes} edges={edges} states={states} onChange={onChange} onRun={onRun} {...rest} />
    </>
  );
}

function InputList({
  node,
  nodes,
  states,
  onReorder,
}: {
  node: GenerateFlowNode;
  nodes: FlowNode[];
  states: Record<string, NodeState> | null;
  onReorder: (inputs: string[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const inputs = node.data.inputs;

  function drop(to: number) {
    if (dragIndex === null || dragIndex === to) return;
    const next = [...inputs];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  }

  return (
    <div className={s.inputs}>
      {inputs.map((sourceId, i) => {
        const source = nodes.find((n) => n.id === sourceId);
        if (!source) return null;
        return (
          <div
            key={sourceId}
            className={cx(s.inputRow, dragIndex === i && s.dragging, overIndex === i && dragIndex !== i && s.over)}
            draggable
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", sourceId);
            }}
            onDragEnter={() => setOverIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              drop(i);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            <InputThumb source={source} state={states?.[source.id]} />
            <div className={s.inputText}>
              <div className={s.inputName}>image {i + 1}</div>
              <div className={s.inputSource}>{nodeTitle(source, nodes)}</div>
            </div>
            <GripVertical size={16} className={s.grip} />
          </div>
        );
      })}
    </div>
  );
}

function InputThumb({ source, state }: { source: FlowNode; state?: NodeState }) {
  const asset = useAsset(source.type === "image" ? source.data.asset : null);
  const src = asset?.thumb ?? state?.outputs?.[0]?.thumb;
  return (
    <div className={cx(s.inputThumb, "checker")}>
      {src ? <img src={src} alt="" /> : source.type === "generate" ? <Sparkles size={16} /> : source.type === "removeBackground" ? <Scissors size={16} /> : <ImageIcon size={16} />}
    </div>
  );
}

// ---------- Image ----------
function ImageSettingsPanel({ node, onChange, onMask }: Props & { node: ImageFlowNode }) {
  const asset = useAsset(node.data.asset);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState(false);

  async function replace(files: FileList) {
    setBusy(true);
    try {
      const [first] = await uploadImages(files);
      if (!first) return toast("That file isn't an image", { tone: "error" });
      rememberAsset(first);
      onChange(node.id, { asset: first.id });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={cx(s.bigImage, "checker")}>
        {asset ? <img src={asset.thumb} alt={asset.name} /> : <span className={s.muted}>No image yet</span>}
      </div>
      {asset && (
        <p className={s.muted}>
          {asset.name} · {asset.width}×{asset.height}
          {asset.hasAlpha ? " · transparent" : ""}
        </p>
      )}
      <div className={s.buttonRow}>
        <Button size="sm" icon={<ImagePlus size={15} />} loading={busy} onClick={() => fileInput.current?.click()}>
          {asset ? "Replace image" : "Choose image"}
        </Button>
        {asset && (
          <Button size="sm" icon={<Brush size={15} />} onClick={() => setMarking(true)}>
            Mark area
          </Button>
        )}
      </div>
      <p className={s.sectionHint}>Mark area circles or paints the part to change; the model reads the marks.</p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void replace(e.target.files);
          e.target.value = "";
        }}
      />
      <MarkArea
        asset={marking ? asset : null}
        onClose={() => setMarking(false)}
        onDone={(result, asMask) => {
          setMarking(false);
          rememberAsset(result);
          if (asMask) onMask(node.id, result);
          else {
            onChange(node.id, { asset: result.id });
            toast("Marks added — describe the change for the marked area in the Generate prompt");
          }
        }}
      />
    </>
  );
}

// ---------- Save folder ----------
function FolderSection({ node, workflowFolder, onChange }: Props) {
  if (node.type === "image" || node.type === "note") return null;
  const own = node.data.folder;
  return (
    <div className={s.section}>
      <div className={s.sectionLabel}>
        Save to
        <span className={s.sectionHint}>{own ? "Only this node" : "Same as the workflow"}</span>
      </div>
      <div className={s.folderRow}>
        <FolderPicker value={own ?? workflowFolder} onChange={(path) => onChange(node.id, { folder: path === workflowFolder ? null : path })} />
        {own && (
          <button type="button" className={s.linkButton} onClick={() => onChange(node.id, { folder: null })}>
            Use the workflow's folder
          </button>
        )}
      </div>
    </div>
  );
}
