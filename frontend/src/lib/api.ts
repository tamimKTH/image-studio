// Typed client for the Image Studio API (see docs/changes/2026-09-28-image-studio/spec.md).

export type Aspect = "auto" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16";
export type Size = "1k" | "2k";
export type Quality = "fast" | "standard" | "best";
export type RefDetail = "standard" | "high" | "original";

export interface Advanced {
  seed: number | null;
  negative: string;
  cfg: number | null;
  steps: number | null;
  sampler: string;
  scheduler: string;
  refDetail: RefDetail;
}

export interface GenerateSettings {
  aspect: Aspect;
  size: Size;
  quality: Quality;
  count: number;
  transparent: boolean;
  advanced: Advanced;
}

export const defaultAdvanced: Advanced = {
  seed: null,
  negative: "",
  cfg: null,
  steps: null,
  sampler: "euler",
  scheduler: "simple",
  refDetail: "standard",
};

export const defaultSettings: GenerateSettings = {
  aspect: "auto",
  size: "1k",
  quality: "standard",
  count: 1,
  transparent: false,
  advanced: defaultAdvanced,
};

export interface Asset {
  id: string;
  /** The original file name as uploaded or saved (not the internal storage name). */
  name: string;
  path: string;
  url: string;
  thumb: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface Folder {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
  count: number;
  cover: string | null;
  exists: boolean;
  lastUsedAt: number | null;
}

export interface FsListing {
  path: string;
  name: string;
  parent: string | null;
  crumbs: { name: string; path: string }[];
  dirs: { name: string; path: string }[];
  places: { name: string; path: string; kind: string }[];
}

export interface FolderImage {
  path: string;
  name: string;
  mtime: number;
  width: number | null;
  height: number | null;
  thumb: string;
  url: string;
}

/** Settings saved in each generated PNG (the "studio" text chunk). */
export interface StudioMeta {
  kind?: "generate" | "removeBackground";
  prompt?: string;
  negative?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  width?: number;
  height?: number;
  sampler?: string;
  scheduler?: string;
  transparent?: boolean;
  inputs?: string[];
  model?: string;
  createdAt?: number;
}

export interface FileInfo {
  path: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  mtime: number;
  meta: StudioMeta | null;
}

export interface EngineStatus {
  online: boolean;
  device: string | null;
  queue: number;
  version: string | null;
  error: string | null;
}

export interface Status {
  engine: EngineStatus;
  models: { generator: boolean; textEncoder: boolean; vae: boolean; enhancerT2I: boolean; enhancerI2I: boolean };
  defaultFolder: string;
}

/** Sampler and scheduler names the engine actually offers (from its KSampler definition). */
export interface Options {
  samplers: string[];
  schedulers: string[];
}

// ---- Graph (shared by workflows and runs; the same shape React Flow uses) ----
/** "note" is a sticky note on the canvas; it never runs and has no connections. */
export type NodeType = "image" | "generate" | "removeBackground" | "note";

export type NoteColor = "yellow" | "blue" | "green" | "pink" | "gray";

export interface NoteNodeData {
  text: string;
  color: NoteColor;
}

export interface ImageNodeData {
  asset: string | null;
}

export interface GenerateNodeData extends GenerateSettings {
  prompt: string;
  inputs: string[];
  autoImprove: boolean;
  folder: string | null;
}

export interface RemoveBackgroundNodeData {
  folder: string | null;
  /** Steps preset for the cut-out; the backend defaults to "standard". */
  quality?: Quality;
}

export type NodeData = ImageNodeData | GenerateNodeData | RemoveBackgroundNodeData | NoteNodeData;

export interface GraphNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Workflow {
  id: string;
  name: string;
  graph: Graph;
  folder: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "canceled";
export type NodeStatus = "waiting" | "queued" | "running" | "done" | "failed" | "skipped" | "canceled";

export interface WorkflowSummary {
  id: string;
  name: string;
  updatedAt: number;
  nodeCount: number;
  cover: string | null;
  lastRun: { id: string; status: RunStatus; total: number; done: number } | null;
}

export interface RunSummary {
  id: string;
  kind: "create" | "workflow";
  workflowId: string | null;
  name: string;
  /** 1 for a workflow's first run, 2 for the second…; null for Create runs. */
  number: number | null;
  status: RunStatus;
  total: number;
  done: number;
  progress: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  thumbs: string[];
  /** Up to 12 finished images, oldest first. */
  outputs: OutputImage[];
  current: { nodeId: string; step: number; steps: number } | null;
}

export interface OutputImage {
  id: string;
  url: string;
  thumb: string;
  path: string;
  name: string;
}

export interface NodeState {
  status: NodeStatus;
  progress: number;
  step: number;
  steps: number;
  error: string | null;
  outputs: OutputImage[];
}

export interface RunDetail extends RunSummary {
  graph: Graph;
  folder: string;
  nodes: Record<string, NodeState>;
}

export interface EnhanceResult {
  prompt: string;
  aspect: Aspect | null;
  matchImage: boolean;
}

export interface CreateRequest extends GenerateSettings {
  prompt: string;
  images: string[];
  folder: string | null;
}

// ---- transport ----
export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  return s.toString();
};

export const api = {
  status: () => request<Status>("GET", "/api/status"),
  settings: () => request<{ defaultFolder: string }>("GET", "/api/settings"),
  saveSettings: (s: { defaultFolder: string }) => request<{ defaultFolder: string }>("PUT", "/api/settings", s),

  listDir: (path?: string) => request<FsListing>("GET", `/api/fs?${q({ path })}`),
  makeDir: (parent: string, name: string) => request<{ path: string }>("POST", "/api/fs/folder", { parent, name }),

  folders: () => request<Folder[]>("GET", "/api/folders"),
  addFolder: (path: string, pinned?: boolean) => request<Folder>("POST", "/api/folders", { path, pinned }),
  updateFolder: (id: string, patch: { pinned?: boolean; name?: string }) => request<Folder>("PATCH", `/api/folders/${id}`, patch),
  forgetFolder: (id: string) => request<void>("DELETE", `/api/folders/${id}`),
  folderImages: (path: string, offset = 0, limit = 120) =>
    request<{ items: FolderImage[]; total: number }>("GET", `/api/folders/images?${q({ path, offset, limit })}`),
  /** Deletes an image into the app's own trash (kept 30 days); `restore` puts it back. */
  trash: (path: string) => request<{ id: string }>("POST", "/api/files/trash", { path }),
  restore: (id: string) => request<{ path: string }>("POST", "/api/files/restore", { id }),
  options: () => request<Options>("GET", "/api/options"),
  fileInfo: (path: string) => request<FileInfo>("GET", `/api/files/info?${q({ path })}`),

  upload: (files: File[] | Blob[], meta?: Record<string, unknown>) => {
    const form = new FormData();
    files.forEach((f, i) => form.append("files", f, f instanceof File ? f.name : `image-${i}.png`));
    if (meta) form.append("meta", JSON.stringify(meta));
    return request<Asset[]>("POST", "/api/assets/upload", form);
  },
  assetFromPath: (path: string) => request<Asset>("POST", "/api/assets/from-path", { path }),
  asset: (id: string) => request<Asset>("GET", `/api/assets/${id}`),

  create: (req: CreateRequest) => request<{ runId: string }>("POST", "/api/create", req),
  removeBackground: (asset: string, folder: string | null, quality?: Quality) =>
    request<{ runId: string }>("POST", "/api/remove-background", { asset, folder, quality }),
  enhance: (prompt: string, images: string[], signal?: AbortSignal) =>
    request<EnhanceResult>("POST", "/api/enhance", { prompt, images }, signal),

  workflows: () => request<WorkflowSummary[]>("GET", "/api/workflows"),
  createWorkflow: (body: { name?: string; graph?: Graph; folder?: string | null; starter?: "blank" | "combine" | "cutout" }) =>
    request<Workflow>("POST", "/api/workflows", body),
  workflow: (id: string) => request<Workflow>("GET", `/api/workflows/${id}`),
  saveWorkflow: (id: string, patch: { name?: string; graph?: Graph; folder?: string | null }) =>
    request<Workflow>("PUT", `/api/workflows/${id}`, patch),
  deleteWorkflow: (id: string) => request<void>("DELETE", `/api/workflows/${id}`),
  duplicateWorkflow: (id: string) => request<Workflow>("POST", `/api/workflows/${id}/duplicate`),
  exportWorkflow: (id: string) => request<Record<string, unknown>>("GET", `/api/workflows/${id}/export`),
  importWorkflow: (data: unknown) => request<Workflow>("POST", "/api/workflows/import", data),
  runWorkflow: (id: string) => request<{ runId: string }>("POST", `/api/workflows/${id}/run`),

  runs: (limit = 60) => request<RunSummary[]>("GET", `/api/runs?${q({ limit })}`),
  run: (id: string) => request<RunDetail>("GET", `/api/runs/${id}`),
  cancelRun: (id: string) => request<void>("POST", `/api/runs/${id}/cancel`),
  /** Starts the run's own graph again: `fresh` makes every image anew; otherwise finished images are kept. */
  retryRun: (id: string, fresh = false) => request<{ runId: string }>("POST", `/api/runs/${id}/retry`, { fresh }),
  deleteRun: (id: string) => request<void>("DELETE", `/api/runs/${id}`),
};

export const fileUrl = (path: string) => `/api/file?${q({ path })}`;
export const thumbUrl = (path: string) => `/api/thumb?${q({ path })}`;
