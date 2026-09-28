import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Activity as ActivityIcon, RotateCcw, Sparkles, Square, Workflow, X } from "lucide-react";
import { api, type RunSummary } from "../lib/api";
import { useLive, usePreview } from "../lib/events";
import { duration, plural, timeAgo } from "../lib/format";
import { isActive, primeRun } from "../components/media/RunResults";
import { Button, Empty, IconButton, cx, toast } from "../components/ui";
import s from "./activity.module.css";

const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

/** "Generating image 2 of 5 · Step 12 of 28", "In queue", "Done · 5 images", "Failed — reason". */
function statusLine(run: RunSummary): { text: string; tone: "running" | "failed" | "done" | "normal" } {
  switch (run.status) {
    case "queued":
      return { text: "In queue", tone: "running" };
    case "running": {
      const step = run.current?.steps ? `Step ${run.current.step} of ${run.current.steps}` : "Loading the model…";
      if (run.total > 1) return { text: `Generating image ${Math.min(run.done + 1, run.total)} of ${run.total} · ${step}`, tone: "running" };
      return { text: `Generating · ${step}`, tone: "running" };
    }
    case "done":
      return { text: `Done · ${plural(run.done || run.outputs.length, "image")}`, tone: "done" };
    case "failed":
      return { text: `Failed${run.error ? ` — ${run.error}` : ""}`, tone: "failed" };
    default:
      return { text: run.done ? `Canceled · ${plural(run.done, "image")} made` : "Canceled", tone: "normal" };
  }
}

function forgetRun(id: string) {
  useLive.setState((st) => {
    const runs = { ...st.runs };
    delete runs[id];
    return { runs };
  });
}

/** Every run, running or finished, with live progress. Click one to see it node by node. */
export function Activity() {
  const navigate = useNavigate();
  const runsMap = useLive((st) => st.runs);
  const { running, recent } = useMemo(() => {
    const all = Object.values(runsMap);
    return {
      // What the engine works on first comes first.
      running: all
        .filter((r) => isActive(r.status))
        .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt - b.createdAt),
      recent: all.filter((r) => !isActive(r.status)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)),
    };
  }, [runsMap]);

  return (
    <div className={s.page}>
      <div className={s.column}>
        <h1 className={s.title}>Activity</h1>
        {!running.length && !recent.length ? (
          <Empty
            icon={<ActivityIcon size={24} />}
            title="Nothing has run yet"
            text="Everything you generate appears here with live progress, even when it runs in the background."
            action={
              <Button variant="primary" icon={<Sparkles size={16} />} onClick={() => navigate("/")}>
                Create an image
              </Button>
            }
          />
        ) : (
          <>
            {running.length > 0 && (
              <section className={s.section} aria-label="Running">
                <h2 className={s.sectionTitle}>
                  Running <span className={s.count}>{running.length}</span>
                </h2>
                <div className={s.list}>
                  {running.map((r) => (
                    <RunRow key={r.id} run={r} />
                  ))}
                </div>
              </section>
            )}
            {recent.length > 0 && (
              <section className={s.section} aria-label="Recent">
                <h2 className={s.sectionTitle}>Recent</h2>
                <div className={s.list}>
                  {recent.map((r) => (
                    <RunRow key={r.id} run={r} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const navigate = useNavigate();
  const active = isActive(run.status);
  const preview = usePreview(run.status === "running" ? run.id : undefined, run.current?.nodeId);
  const status = statusLine(run);
  const thumbs = run.outputs.slice(-3).map((o) => o.thumb);
  if (preview && thumbs.length < 3) thumbs.push(preview);
  const KindIcon = run.kind === "workflow" ? Workflow : Sparkles;
  const open = () => navigate(`/runs/${run.id}`);

  async function cancel() {
    try {
      await api.cancelRun(run.id);
      toast("Canceled");
    } catch (e) {
      errorToast(e);
    }
  }

  async function runAgain() {
    try {
      const { runId } = await api.retryRun(run.id);
      await primeRun(runId);
      toast("Running again", { action: { label: "Open", onClick: () => navigate(`/runs/${runId}`) } });
    } catch (e) {
      errorToast(e);
    }
  }

  async function remove() {
    try {
      await api.deleteRun(run.id);
      forgetRun(run.id);
    } catch (e) {
      errorToast(e);
    }
  }

  const time = active
    ? run.startedAt
      ? `Started ${timeAgo(run.startedAt)}`
      : `Added ${timeAgo(run.createdAt)}`
    : `${timeAgo(run.finishedAt ?? run.createdAt)}${run.finishedAt && run.startedAt ? ` · took ${duration(run.finishedAt - run.startedAt)}` : ""}`;

  return (
    <div
      className={s.row}
      role="link"
      tabIndex={0}
      aria-label={`Open ${run.name}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}
    >
      <div className={s.stack} aria-hidden>
        {thumbs.length ? (
          thumbs.map((src, i) => (
            <div key={`${src.slice(-40)}-${i}`} className={`${s.stackImage} checker`} style={{ left: i * 10, zIndex: i }}>
              <img src={src} alt="" />
            </div>
          ))
        ) : (
          <div className={s.stackIcon}>
            <KindIcon size={20} />
          </div>
        )}
      </div>

      <div className={s.main}>
        <div className={s.name} title={run.name}>
          <span className={s.kind} title={run.kind === "workflow" ? "Workflow" : "Create"}>
            <KindIcon size={14} />
          </span>
          {run.name}
        </div>
        <div
          className={cx(
            s.statusLine,
            status.tone === "running" && s.running,
            status.tone === "failed" && s.failed,
            status.tone === "done" && s.done,
          )}
          title={status.text}
        >
          {status.text}
        </div>
        {active && (
          <div className={s.bar} role="progressbar" aria-valuenow={Math.round(run.progress * 100)}>
            <div
              className={cx(s.barFill, run.status === "queued" && s.barQueued)}
              style={run.status === "queued" ? undefined : { width: `${Math.max(3, run.progress * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div className={s.time}>{time}</div>

      <div className={s.actions} onClick={(e) => e.stopPropagation()}>
        {active ? (
          <IconButton label="Cancel" onClick={cancel}>
            <Square size={15} />
          </IconButton>
        ) : (
          <>
            <IconButton label="Run again" onClick={runAgain}>
              <RotateCcw size={16} />
            </IconButton>
            <IconButton label="Remove from history (images stay in their folder)" onClick={remove}>
              <X size={16} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}
