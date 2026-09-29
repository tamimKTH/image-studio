// Pure helpers for the workflow graph: conversion to and from React Flow, input order, validation, clipboard.
import type { Edge, Node, XYPosition } from "@xyflow/react";
import {
  defaultSettings,
  type GenerateNodeData,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type ImageNodeData,
  type NodeState,
  type NodeType,
  type NoteColor,
  type NoteNodeData,
  type RemoveBackgroundNodeData,
  type RunStatus,
} from "../lib/api";

type Data<T> = T & Record<string, unknown>;
/** A note also remembers its size (the saved graph keeps it in `data`). */
export type NoteData = NoteNodeData & { width?: number; height?: number };
export type ImageFlowNode = Node<Data<ImageNodeData>, "image">;
export type GenerateFlowNode = Node<Data<GenerateNodeData>, "generate">;
export type RemoveBgFlowNode = Node<Data<RemoveBackgroundNodeData>, "removeBackground">;
export type NoteFlowNode = Node<Data<NoteData>, "note">;
export type FlowNode = ImageFlowNode | GenerateFlowNode | RemoveBgFlowNode | NoteFlowNode;

export const MAX_INPUTS = 10;
export const NODE_WIDTH = 248;
/** Card heights before React Flow has measured them. An Image card with a picture follows `imageCardSize` instead. */
const NODE_HEIGHT: Record<NodeType, number> = { image: 236, generate: 292, removeBackground: 214, note: 160 };

/** An Image card's picture box when it has no picture yet; the card adds IMAGE_CHROME around the box. */
const IMAGE_BOX = { width: 224, height: 156 };
export const IMAGE_CHROME = { width: NODE_WIDTH - IMAGE_BOX.width, height: NODE_HEIGHT.image - IMAGE_BOX.height };
const IMAGE_AREA = 40_000;
const IMAGE_WIDTH = { min: 176, max: 280 };
const IMAGE_HEIGHT = { min: 120, max: 240 };

/** The picture's box on an Image card: about the same area for every image, in the image's own proportions. */
export function imageBoxSize(width: number, height: number): { width: number; height: number } | null {
  if (!width || !height) return null;
  const ratio = width / height;
  const boxWidth = Math.round(Math.min(IMAGE_WIDTH.max, Math.max(IMAGE_WIDTH.min, Math.sqrt(IMAGE_AREA * ratio))));
  const boxHeight = Math.round(Math.min(IMAGE_HEIGHT.max, Math.max(IMAGE_HEIGHT.min, boxWidth / ratio)));
  return { width: boxWidth, height: boxHeight };
}

/** The whole Image card for a picture of this size, before React Flow has measured it. */
export function imageCardSize(width: number, height: number): { width: number; height: number } {
  const box = imageBoxSize(width, height) ?? IMAGE_BOX;
  return { width: box.width + IMAGE_CHROME.width, height: box.height + IMAGE_CHROME.height };
}
export const NOTE_SIZE = { width: 240, height: 160 };
export const NOTE_COLORS: NoteColor[] = ["yellow", "blue", "green", "pink", "gray"];

export const TYPE_LABEL: Record<NodeType, string> = {
  image: "Image",
  generate: "Generate",
  removeBackground: "Remove background",
  note: "Note",
};

export const newId = (prefix = "n") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export function defaultData(type: NodeType): FlowNode["data"] {
  if (type === "image") return { asset: null };
  if (type === "removeBackground") return { folder: null };
  if (type === "note") return { text: "", color: "yellow", ...NOTE_SIZE };
  return { ...defaultSettings, advanced: { ...defaultSettings.advanced }, prompt: "", inputs: [], autoImprove: false, folder: null };
}

/** Notes carry their size as node width/height; other cards size themselves. */
function withSize(node: FlowNode): FlowNode {
  if (node.type !== "note") return node;
  return { ...node, width: node.data.width ?? NOTE_SIZE.width, height: node.data.height ?? NOTE_SIZE.height };
}

export function makeNode(type: NodeType, position: XYPosition, data?: FlowNode["data"]): FlowNode {
  return withSize({ id: newId(), type, position, data: data ?? defaultData(type) } as FlowNode);
}

export function toFlowNodes(nodes: GraphNode[]): FlowNode[] {
  return nodes.map((n) => withSize({ id: n.id, type: n.type, position: { ...n.position }, data: structuredClone(n.data) } as FlowNode));
}

export function toFlowEdges(edges: Graph["edges"]): Edge[] {
  return edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
}

function savedData(n: FlowNode): GraphNode["data"] {
  if (n.type !== "note") return n.data as GraphNode["data"];
  const width = Math.round(n.width ?? n.measured?.width ?? n.data.width ?? NOTE_SIZE.width);
  const height = Math.round(n.height ?? n.measured?.height ?? n.data.height ?? NOTE_SIZE.height);
  return { ...n.data, width, height } as GraphNode["data"];
}

/** The saved form: only id, type, position and data; positions rounded. */
export function fromFlow(nodes: FlowNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as NodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: savedData(n),
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/**
 * Keeps every Generate node's `inputs` in line with its incoming edges: the saved order is kept,
 * sources no longer connected are dropped and new ones are appended in edge order.
 */
export function syncInputs(nodes: FlowNode[], edges: Edge[]): FlowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.map((n) => {
    if (n.type !== "generate") return n;
    const connected = edges.filter((e) => e.target === n.id && ids.has(e.source)).map((e) => e.source);
    const kept = n.data.inputs.filter((i) => connected.includes(i));
    const inputs = [...kept, ...connected.filter((c) => !kept.includes(c))];
    if (inputs.length === n.data.inputs.length && inputs.every((v, i) => v === n.data.inputs[i])) return n;
    return { ...n, data: { ...n.data, inputs } };
  });
}

/** Removes edges whose ends no longer exist. */
export function pruneEdges(nodes: FlowNode[], edges: Edge[]): Edge[] {
  const ids = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

/** Can `target` reach `source` through outgoing edges? Then source → target would close a loop. */
export function wouldCycle(source: string, target: string, edges: Edge[]): boolean {
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

/** Why a connection is not allowed, or null when it is. */
export function connectionProblem(source: string, target: string, nodes: FlowNode[], edges: Edge[]): string | null {
  if (source === target) return "A node can't connect to itself";
  const s = nodes.find((n) => n.id === source);
  const t = nodes.find((n) => n.id === target);
  if (!s || !t) return "That node no longer exists";
  if (s.type === "note" || t.type === "note") return "Notes don't connect to anything";
  if (t.type === "image") return "Images have no input — connect from an image into Generate or Remove background";
  if (edges.some((e) => e.source === source && e.target === target)) return "Already connected";
  const incoming = edges.filter((e) => e.target === target).length;
  if (t.type === "removeBackground" && incoming >= 1) return "Remove background takes one image — remove its connection first";
  if (t.type === "generate" && incoming >= MAX_INPUTS) return `Generate takes up to ${MAX_INPUTS} images`;
  if (wouldCycle(source, target, edges)) return "That would make a loop";
  return null;
}

/**
 * A connection dragged out of `fromNode` and released on another node's card (not on its dot):
 * the source and target it means. Dragged from an output → into the card's input; from an input → from its output.
 */
export function connectionToCard(fromNode: string, fromHandle: "source" | "target", cardNode: string): { source: string; target: string } {
  return fromHandle === "source" ? { source: fromNode, target: cardNode } : { source: cardNode, target: fromNode };
}

/** "Generate", or "Generate 2" when there are several of that kind. */
export function nodeTitle(node: { id: string; type?: string }, nodes: { id: string; type?: string }[]): string {
  const type = node.type as NodeType;
  const same = nodes.filter((n) => n.type === type);
  const label = TYPE_LABEL[type] ?? "Node";
  if (same.length < 2) return label;
  return `${label} ${same.findIndex((n) => n.id === node.id) + 1}`;
}

/** First problem that would stop a run, with the node to select. Notes are ignored. */
export function validate(nodes: FlowNode[], edges: Edge[]): { nodeId: string | null; message: string } | null {
  if (!nodes.some((n) => n.type === "generate" || n.type === "removeBackground"))
    return { nodeId: null, message: "Add a Generate node — it makes the images" };
  for (const n of nodes) {
    const title = nodeTitle(n, nodes);
    if (n.type === "image" && !n.data.asset) return { nodeId: n.id, message: `Choose a picture for ${title}` };
    if (n.type === "generate" && !n.data.prompt.trim()) return { nodeId: n.id, message: `Write a prompt for ${title}` };
    if (n.type === "removeBackground" && !edges.some((e) => e.target === n.id))
      return { nodeId: n.id, message: `Connect an image to ${title}` };
  }
  return null;
}

/** Node ids in dependency order (inputs before the nodes that use them). */
export function topoOrder(graph: Graph): string[] {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 1) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return order;
}

/**
 * How far a run is, 0–1: finished images plus the running image's part, over all images of the run.
 * (Image and note nodes make no images.)
 */
export function runProgress(run: { graph: Graph; nodes: Record<string, NodeState>; total: number; status: RunStatus }): number {
  if (run.status === "done") return 1;
  let finished = 0;
  for (const n of run.graph.nodes) {
    if (n.type !== "generate" && n.type !== "removeBackground") continue;
    const units = n.type === "generate" ? Math.max(1, (n.data as GenerateNodeData).count || 1) : 1;
    const state = run.nodes[n.id];
    if (state?.status === "done") finished += units;
    else if (state?.status === "running") finished += units * Math.min(1, Math.max(0, state.progress || 0));
  }
  return run.total ? Math.min(1, finished / run.total) : 0;
}

export function nodeHeight(type: NodeType): number {
  return NODE_HEIGHT[type];
}

/** A node's current size: measured by React Flow when available. */
export function nodeSize(n: FlowNode): { width: number; height: number } {
  return {
    width: n.measured?.width ?? n.width ?? NODE_WIDTH,
    height: n.measured?.height ?? n.height ?? NODE_HEIGHT[n.type as NodeType] ?? 220,
  };
}

/** The box around some nodes, in canvas coordinates. */
export function boundsOf(nodes: FlowNode[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...nodes.map((n) => n.position.x));
  const y = Math.min(...nodes.map((n) => n.position.y));
  const right = Math.max(...nodes.map((n) => n.position.x + nodeSize(n).width));
  const bottom = Math.max(...nodes.map((n) => n.position.y + nodeSize(n).height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A free spot near `wanted` for a new node of `type` (or a group of nodes of `size`): first `wanted` itself,
 * then the same column below and above, then further to the right — never to the left,
 * so a node added "next" stays after its source.
 */
export function freeSpot(wanted: XYPosition, size: NodeType | { width: number; height: number }, nodes: FlowNode[]): XYPosition {
  const w = typeof size === "string" ? (size === "note" ? NOTE_SIZE.width : NODE_WIDTH) : size.width;
  const h = typeof size === "string" ? NODE_HEIGHT[size] : size.height;
  const gap = 28;
  const overlaps = (p: XYPosition) =>
    nodes.some((n) => {
      const size = nodeSize(n);
      return (
        p.x < n.position.x + size.width + gap &&
        p.x + w + gap > n.position.x &&
        p.y < n.position.y + size.height + gap &&
        p.y + h + gap > n.position.y
      );
    });
  for (let column = 0; column < 6; column++)
    for (const row of [0, 1, -1, 2, -2, 3]) {
      const p = { x: wanted.x + column * (w + 60), y: wanted.y + row * (h + 40) };
      if (!overlaps(p)) return p;
    }
  return { x: wanted.x, y: wanted.y + 40 };
}

// ---------- clipboard ----------
export const CLIPBOARD_FORMAT = "image-studio.nodes";

export interface NodeClipboard {
  format: typeof CLIPBOARD_FORMAT;
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function isNodeClipboard(data: unknown): data is NodeClipboard {
  return !!data && typeof data === "object" && (data as { format?: string }).format === CLIPBOARD_FORMAT && Array.isArray((data as NodeClipboard).nodes);
}

/** The selected nodes and the connections between them, in the saved form. */
export function copySelection(nodes: FlowNode[], edges: Edge[]): NodeClipboard | null {
  const selected = nodes.filter((n) => n.selected);
  if (!selected.length) return null;
  const ids = new Set(selected.map((n) => n.id));
  const graph = fromFlow(
    selected,
    edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  );
  return { format: CLIPBOARD_FORMAT, version: 1, ...graph };
}

/**
 * Copies of clipboard nodes with new ids, moved so their top-left corner lands at `at`,
 * with connections among them kept and Generate input order remapped.
 */
export function pasteNodes(clip: { nodes: GraphNode[]; edges: GraphEdge[] }, at: XYPosition): { nodes: FlowNode[]; edges: Edge[] } {
  const known = clip.nodes.filter((n) => n && TYPE_LABEL[n.type] && n.position);
  const idMap = new Map(known.map((n) => [n.id, newId()]));
  const minX = Math.min(...known.map((n) => n.position.x));
  const minY = Math.min(...known.map((n) => n.position.y));
  const nodes = known.map((n) => {
    const data = structuredClone(n.data) as FlowNode["data"] & { inputs?: string[] };
    if (n.type === "generate" && Array.isArray(data.inputs)) data.inputs = data.inputs.filter((i) => idMap.has(i)).map((i) => idMap.get(i)!);
    return withSize({
      id: idMap.get(n.id)!,
      type: n.type,
      position: { x: at.x + (n.position.x - minX), y: at.y + (n.position.y - minY) },
      data,
      selected: true,
    } as FlowNode);
  });
  const edges = (clip.edges ?? [])
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({ id: newId("e"), source: idMap.get(e.source)!, target: idMap.get(e.target)! }));
  return { nodes, edges };
}
