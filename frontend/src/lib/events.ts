// Live state from the server-sent event stream: engine status, runs, node progress and previews.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, type EngineStatus, type NodeState, type RunDetail, type RunSummary } from "./api";

type NodeEvent = { runId: string; nodeId: string } & Partial<NodeState>;

interface LiveState {
  connected: boolean;
  engine: EngineStatus | null;
  runs: Record<string, RunSummary>;
  nodes: Record<string, Record<string, Partial<NodeState>>>;
  previews: Record<string, string>;
  folderVersion: Record<string, number>;
  setRuns: (runs: RunSummary[]) => void;
}

export const useLive = create<LiveState>((set) => ({
  connected: false,
  engine: null,
  runs: {},
  nodes: {},
  previews: {},
  folderVersion: {},
  setRuns: (list) => set({ runs: Object.fromEntries(list.map((r) => [r.id, r])) }),
}));

const isActive = (r: RunSummary) => r.status === "queued" || r.status === "running";

let source: EventSource | null = null;

async function refresh() {
  try {
    const [status, runs] = await Promise.all([api.status(), api.runs()]);
    useLive.setState({ engine: status.engine });
    useLive.getState().setRuns(runs);
  } catch {
    /* the stream reconnects and refreshes again */
  }
}

/** Opens the event stream once for the whole app. */
export function startEvents() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    useLive.setState({ connected: true });
    void refresh();
  };
  source.onerror = () => useLive.setState({ connected: false });

  source.addEventListener("engine", (e) => useLive.setState({ engine: JSON.parse((e as MessageEvent).data) }));
  source.addEventListener("run", (e) => {
    const run: RunSummary = JSON.parse((e as MessageEvent).data);
    useLive.setState((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  });
  source.addEventListener("node", (e) => {
    const { runId, nodeId, ...rest }: NodeEvent = JSON.parse((e as MessageEvent).data);
    useLive.setState((s) => ({
      nodes: { ...s.nodes, [runId]: { ...s.nodes[runId], [nodeId]: { ...s.nodes[runId]?.[nodeId], ...rest } } },
    }));
  });
  source.addEventListener("preview", (e) => {
    const { runId, nodeId, image } = JSON.parse((e as MessageEvent).data);
    useLive.setState((s) => ({ previews: { ...s.previews, [`${runId}:${nodeId}`]: image } }));
  });
  source.addEventListener("folder", (e) => {
    const { path } = JSON.parse((e as MessageEvent).data);
    useLive.setState((s) => ({ folderVersion: { ...s.folderVersion, [path]: (s.folderVersion[path] ?? 0) + 1 } }));
  });
}

/** Runs newest first. */
export function useRunList(): RunSummary[] {
  const runs = useLive((s) => s.runs);
  return Object.values(runs).sort((a, b) => b.createdAt - a.createdAt);
}

export function useActiveCount(): number {
  return useLive((s) => Object.values(s.runs).filter(isActive).length);
}

export function usePreview(runId: string | undefined, nodeId: string | undefined): string | undefined {
  return useLive((s) => (runId && nodeId ? s.previews[`${runId}:${nodeId}`] : undefined));
}

/** Changes whenever images are added to or removed from a folder. */
export function useFolderVersion(path: string | null | undefined): number {
  return useLive((s) => (path ? s.folderVersion[path] ?? 0 : 0));
}

/** Full run detail kept live: the fetched snapshot merged with streamed run and node events. */
export function useRun(runId: string | undefined): { run: RunDetail | null; error: string | null } {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = useLive((s) => (runId ? s.runs[runId] : undefined));
  const liveNodes = useLive((s) => (runId ? s.nodes[runId] : undefined));

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .run(runId)
      .then((r) => !cancelled && setDetail(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Re-fetch once when the run finishes so outputs and final states are complete.
  const finished = summary && !isActive(summary);
  useEffect(() => {
    if (runId && finished) api.run(runId).then(setDetail).catch(() => undefined);
  }, [runId, finished]);

  if (!detail) return { run: null, error };
  const nodes = { ...detail.nodes };
  for (const [id, patch] of Object.entries(liveNodes ?? {})) {
    nodes[id] = { ...nodes[id], ...patch } as NodeState;
  }
  return { run: { ...detail, ...(summary ?? {}), nodes }, error };
}
