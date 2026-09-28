import { useEffect, useRef, useState } from "react";
import { Brush, Circle, Undo2 } from "lucide-react";
import { api, type Asset } from "../../lib/api";
import { Button, IconButton, Modal, Segmented, toast } from "../ui";
import s from "./composer.module.css";

type Stroke =
  | { kind: "brush"; size: number; points: [number, number][] }
  | { kind: "circle"; size: number; x: number; y: number; rx: number; ry: number };

const MARK_COLOR = "#ff2d55";

interface Props {
  asset: Asset | null;
  onClose: () => void;
  /** The annotated copy, or a black-and-white mask when `asMask`. The original is never changed. */
  onDone: (result: Asset, asMask: boolean) => void;
}

/** Circle or paint the area to change — the model reads the marks (or a separate mask). */
export function MarkArea({ asset, onClose, onDone }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<"brush" | "circle">("circle");
  const [output, setOutput] = useState<"marks" | "mask">("marks");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef<Stroke | null>(null);
  const start = useRef<[number, number]>([0, 0]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!asset) return;
    setStrokes([]);
    const img = new Image();
    img.onload = () => {
      image.current = img;
      const c = canvas.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      render([]);
    };
    img.src = asset.url;
  }, [asset]);

  const lineWidth = () => Math.max(6, Math.round((image.current?.naturalWidth ?? 1024) / 110));

  function paint(ctx: CanvasRenderingContext2D, list: Stroke[], color: string, fill: boolean) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const st of list) {
      ctx.lineWidth = st.size;
      ctx.beginPath();
      if (st.kind === "brush") {
        st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (st.points.length === 1) ctx.lineTo(st.points[0][0] + 0.1, st.points[0][1]);
        ctx.stroke();
      } else {
        ctx.ellipse(st.x, st.y, Math.max(1, st.rx), Math.max(1, st.ry), 0, 0, Math.PI * 2);
        if (fill) ctx.fill();
        ctx.stroke();
      }
    }
  }

  function render(list: Stroke[]) {
    const c = canvas.current;
    const img = image.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    ctx.globalAlpha = 0.92;
    paint(ctx, list, MARK_COLOR, false);
    ctx.globalAlpha = 1;
  }

  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    const c = canvas.current!;
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    start.current = [x, y];
    drawing.current = tool === "brush" ? { kind: "brush", size: lineWidth() * 2.2, points: [[x, y]] } : { kind: "circle", size: lineWidth(), x, y, rx: 0, ry: 0 };
    render([...strokes, drawing.current]);
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const st = drawing.current;
    if (!st) return;
    const [x, y] = point(e);
    if (st.kind === "brush") st.points.push([x, y]);
    else {
      const [sx, sy] = start.current;
      st.x = (sx + x) / 2;
      st.y = (sy + y) / 2;
      st.rx = Math.abs(x - sx) / 2;
      st.ry = Math.abs(y - sy) / 2;
    }
    render([...strokes, st]);
  }

  function onUp() {
    const st = drawing.current;
    drawing.current = null;
    if (!st) return;
    if (st.kind === "circle" && st.rx < 4 && st.ry < 4) return render(strokes);
    const next = [...strokes, st];
    setStrokes(next);
    render(next);
  }

  function undo() {
    const next = strokes.slice(0, -1);
    setStrokes(next);
    render(next);
  }

  async function finish() {
    const img = image.current;
    if (!asset || !img || !strokes.length) return;
    setSaving(true);
    try {
      let blob: Blob;
      if (output === "mask") {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, c.width, c.height);
        paint(ctx, strokes, "#fff", true);
        blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));
      } else {
        render(strokes);
        blob = await new Promise<Blob>((res) => canvas.current!.toBlob((b) => res(b!), "image/png"));
      }
      const name = asset.name.replace(/\.[^.]+$/, "") + (output === "mask" ? "-mask.png" : "-marked.png");
      const [result] = await api.upload([new File([blob], name, { type: "image/png" })], { parent: asset.id, mark: output });
      onDone(result, output === "mask");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!asset}
      onClose={onClose}
      title="Mark the area to change"
      size="full"
      bodyClassName={s.markBody}
      footer={
        <>
          <span className={s.markHint}>
            {output === "marks"
              ? "The marks are drawn on a copy of the image. Then say what to do, e.g. “replace the circled area with a window”."
              : "A black-and-white mask is added as an extra image. Then say e.g. “change the white area of image 2 in image 1”."}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={finish} loading={saving} disabled={!strokes.length}>
            Use marks
          </Button>
        </>
      }
    >
      <div className={s.markTools}>
        <Segmented
          label="Tool"
          value={tool}
          onChange={setTool}
          options={[
            { value: "circle", label: <span className={s.inline}><Circle size={15} /> Circle</span> },
            { value: "brush", label: <span className={s.inline}><Brush size={15} /> Paint</span> },
          ]}
        />
        <Segmented
          label="Output"
          value={output}
          onChange={setOutput}
          options={[
            { value: "marks", label: "Marks on image", title: "Draw the marks on a copy of the image" },
            { value: "mask", label: "Separate mask", title: "Add a black-and-white mask as another image" },
          ]}
        />
        <IconButton label="Undo last mark" onClick={undo} disabled={!strokes.length}>
          <Undo2 size={17} />
        </IconButton>
      </div>
      <div className={`${s.markStage} checker`}>
        <canvas
          ref={canvas}
          className={s.markCanvas}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
    </Modal>
  );
}
