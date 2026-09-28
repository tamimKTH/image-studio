import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Copy, Download, ImagePlus, Pencil, RotateCcw, Square, Trash2 } from "lucide-react";
import { api, defaultAdvanced, type OutputImage, type RunDetail } from "../lib/api";
import { duration, shortPath, timeAgo } from "../lib/format";
import { sendToCreate } from "../lib/handoff";
import { QUALITY_STEPS, optionLabel } from "../components/composer/MoreSettings";
import { CardAction } from "../components/media/ImageCard";
import { Lightbox, type LightboxItem } from "../components/media/Lightbox";
import {
  ResultRow,
  downloadFile,
  generateData,
  isActive,
  outputAsset,
  primeRun,
  runAgain as startAgain,
  runAgainLabel,
  runInputs,
  runStatusText,
  settingsSummary,
  useTrash,
  workNodeId,
} from "../components/media/RunResults";
import { Button, IconButton, toast } from "../components/ui";
import s from "./createRun.module.css";

const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

/** Results of one Create run (opened from Activity or a link): big images, progress, prompt and settings. */
export function CreateRunView({ run }: { run: RunDetail }) {
  const navigate = useNavigate();
  const { trashed, trash } = useTrash();
  const [openPath, setOpenPath] = useState<string | null>(null);

  const g = generateData(run);
  const nodeId = workNodeId(run);
  const inputs = runInputs(run);
  const node = run.nodes[nodeId];
  const outputs = (node?.outputs?.length ? node.outputs : run.outputs).filter((o) => !trashed.has(o.path));
  const status = runStatusText(run, run);
  const active = isActive(run.status);
  const title = nodeId === "cut" ? "Remove background" : g?.prompt ?? run.name;

  const items: LightboxItem[] = outputs.map((o) => ({
    url: o.url,
    path: o.path,
    name: o.name,
    compareUrl: inputs.length === 1 ? inputs[0].url : null,
  }));
  const openIndex = openPath ? items.findIndex((i) => i.path === openPath) : -1;

  async function cancel() {
    try {
      await api.cancelRun(run.id);
      toast("Canceled");
    } catch (e) {
      errorToast(e);
    }
  }

  const again = runAgainLabel(run);
  async function runAgain() {
    try {
      const runId = await startAgain(run);
      await primeRun(runId);
      navigate(`/runs/${runId}`);
    } catch (e) {
      errorToast(e);
    }
  }

  async function editInCreate() {
    try {
      sendToCreate(await Promise.all(inputs.map(outputAsset)), g?.prompt ?? null);
      navigate("/");
    } catch (e) {
      errorToast(e);
    }
  }

  async function sendOutputToCreate(o: OutputImage) {
    try {
      sendToCreate([await outputAsset(o)]);
      navigate("/");
    } catch (e) {
      errorToast(e);
    }
  }

  const cardActions = (o: OutputImage) => (
    <>
      <CardAction label="Use as input" onClick={() => sendOutputToCreate(o)}>
        <ImagePlus size={15} />
      </CardAction>
      <CardAction label="Download" onClick={() => downloadFile(o.url, o.name)}>
        <Download size={15} />
      </CardAction>
      <CardAction label="Delete" onClick={() => trash(o.path)}>
        <Trash2 size={15} />
      </CardAction>
    </>
  );

  const facts: [string, string][] = [];
  if (g) {
    const a = { ...defaultAdvanced, ...g.advanced };
    const quality = g.quality in QUALITY_STEPS ? g.quality : "standard";
    facts.push(["Size", g.size === "2k" ? "2K (native)" : "1K"]);
    facts.push(["Aspect", g.aspect === "auto" ? (inputs.length ? "Matches image 1" : "1:1") : g.aspect]);
    facts.push([
      "Quality",
      a.steps !== null ? `${a.steps} steps (custom)` : `${quality[0].toUpperCase()}${quality.slice(1)} · ${QUALITY_STEPS[quality]} steps`,
    ]);
    if (g.count > 1) facts.push(["Variations", String(g.count)]);
    if (g.transparent) facts.push(["Background", "Transparent"]);
    facts.push(["Seed", a.seed === null ? "Random" : String(a.seed)]);
    if (a.negative.trim()) facts.push(["Avoid", a.negative.trim()]);
    if (a.cfg !== null) facts.push(["Guidance", String(a.cfg)]);
    if (a.sampler !== "euler" || a.scheduler !== "simple") facts.push(["Sampler", `${optionLabel(a.sampler)} · ${optionLabel(a.scheduler)}`]);
  }
  facts.push(["Started", timeAgo(run.startedAt ?? run.createdAt)]);
  if (run.finishedAt && run.startedAt) facts.push(["Took", duration(run.finishedAt - run.startedAt)]);

  return (
    <div className={s.page}>
      <div className={s.top}>
        <IconButton label="Back" onClick={() => (history.length > 1 ? navigate(-1) : navigate("/activity"))}>
          <ArrowLeft size={18} />
        </IconButton>
        <div className={s.titleBlock}>
          <h1 className={s.title} title={title}>
            {title}
          </h1>
          <div className={s.status}>
            <span className={status.tone === "running" ? s.running : status.tone === "failed" ? s.failed : undefined}>{status.text}</span>
            {nodeId !== "cut" && g && ` · ${settingsSummary(run)}`}
          </div>
        </div>
        <div className={s.actions}>
          {active ? (
            <Button icon={<Square size={15} />} onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button icon={<RotateCcw size={16} />} onClick={runAgain} title={again.title}>
              {again.label}
            </Button>
          )}
          <Button icon={<Pencil size={16} />} onClick={editInCreate}>
            Edit in Create
          </Button>
        </div>
      </div>

      {active && (
        <div className={s.progress} role="progressbar" aria-valuenow={Math.round(run.progress * 100)}>
          <div className={s.progressBar} style={{ width: `${Math.max(3, run.progress * 100)}%` }} />
        </div>
      )}

      <div className={s.body}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {run.status === "failed" && run.error && <div className={s.error}>{run.error}</div>}
          <ResultRow
            summary={run}
            detail={run}
            maxHeight={640}
            trashed={trashed}
            onOpen={(o) => setOpenPath(o.path)}
            cardActions={cardActions}
          />
        </div>

        <aside className={s.details}>
          {g?.prompt && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>Prompt</h2>
              <p className={s.prompt}>{g.prompt}</p>
              <Button
                size="sm"
                variant="ghost"
                className={s.copy}
                icon={<Copy size={14} />}
                onClick={() => navigator.clipboard.writeText(g.prompt).then(() => toast("Prompt copied"))}
              >
                Copy prompt
              </Button>
            </section>
          )}
          {inputs.length > 0 && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>{inputs.length === 1 ? "Input image" : "Input images"}</h2>
              <div className={s.inputs}>
                {inputs.map((o, i) => (
                  <figure key={`${o.id}-${i}`} className={`${s.input} checker`} title={`image ${i + 1}`}>
                    <img src={o.thumb} alt={`Input ${i + 1}`} />
                    <span>{i + 1}</span>
                  </figure>
                ))}
              </div>
            </section>
          )}
          <section className={s.section}>
            <h2 className={s.sectionTitle}>Details</h2>
            <dl className={s.facts}>
              {facts.map(([k, v]) => (
                <span key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </span>
              ))}
            </dl>
          </section>
          {run.folder && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>Saved in</h2>
              <p className={s.path}>{shortPath(run.folder)}</p>
            </section>
          )}
        </aside>
      </div>

      <Lightbox
        items={items}
        index={openIndex >= 0 ? openIndex : null}
        onIndex={(i) => setOpenPath(i === null ? null : items[i]?.path ?? null)}
        actions={(item) => {
          const index = items.findIndex((x) => x.path === item.path);
          const output = outputs[index];
          if (!output) return null;
          return (
            <>
              <Button icon={<ImagePlus size={16} />} onClick={() => sendOutputToCreate(output)}>
                Use as input
              </Button>
              <Button
                icon={<Trash2 size={16} />}
                onClick={async () => {
                  const next = items[index + 1] ?? items[index - 1];
                  if (await trash(output.path)) setOpenPath(next && next.path !== output.path ? next.path : null);
                }}
              >
                Delete
              </Button>
            </>
          );
        }}
      />
    </div>
  );
}
