// Pure helpers for the workflow graph: conversion to and from React Flow, input order, validation.
import type { Edge, Node, XYPosition } from "@xyflow/react";
import {
  defaultSettings,
  type GenerateNodeData,
  type Graph,
  type GraphNode,
  type ImageNodeData,
  type NodeType,
  type RemoveBackgroundNodeData,
} from "../lib/api";

type Data<T> = T & Record<string, unknown>;
export type ImageFlowNode = Node<Data<ImageNodeData>, "image">;
export type GenerateFlowNode = Node<Data<GenerateNodeData>, "generate">;
export type RemoveBgFlowNode = Node<Data<RemoveBackgroundNodeData>, "removeBackground">;
export type FlowNode = ImageFlowNode | GenerateFlowNode | RemoveBgFlowNode;

export const MAX_INPUTS = 10;
export const NODE_WIDTH = 248;
const NODE_HEIGHT: Record<NodeType, number> = { image: 230, generate: 240, removeBackground: 210 };

export const TYPE_LABEL: Record<NodeType, string> = {
  image: "Image",
  generate: "Generate",
  removeBackground: "Remove background",
};

export const newId = (prefix = "n") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export function defaultData(type: NodeType): FlowNode["data"] {
  if (type === "image") return { asset: null };
  if (type === "removeBackground") return { folder: null };
  return { ...defaultSettings, advanced: { ...defaultSettings.advanced }, prompt: "", inputs: [], autoImprove: false, folder: null };
}

export function makeNode(type: NodeType, position: XYPosition, data?: FlowNode["data"]): FlowNode {
  return { id: newId(), type, position, data: data ?? defaultData(type) } as FlowNode;
}

export function toFlowNodes(nodes: GraphNode[]): FlowNode[] {
  return nodes.map((n) => ({ id: n.id, type: n.type, position: { ...n.position }, data: structuredClone(n.data) }) as FlowNode);
}

export function toFlowEdges(edges: Graph["edges"]): Edge[] {
  return edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
}

/** The saved form: only id, type, position and data; positions rounded. */
export function fromFlow(nodes: FlowNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as NodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data as GraphNode["data"],
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
  const t = nodes.find((n) => n.id === target);
  if (!t || t.type === "image") return "Images have no input";
  if (edges.some((e) => e.source === source && e.target === target)) return "Already connected";
  const incoming = edges.filter((e) => e.target === target).length;
  if (t.type === "removeBackground" && incoming >= 1) return "Remove background takes one image";
  if (t.type === "generate" && incoming >= MAX_INPUTS) return `Generate takes up to ${MAX_INPUTS} images`;
  if (wouldCycle(source, target, edges)) return "That would make a loop";
  return null;
}

/** "Generate", or "Generate 2" when there are several of that kind. */
export function nodeTitle(node: { id: string; type?: string }, nodes: { id: string; type?: string }[]): string {
  const type = node.type as NodeType;
  const same = nodes.filter((n) => n.type === type);
  const label = TYPE_LABEL[type] ?? "Node";
  if (same.length < 2) return label;
  return `${label} ${same.findIndex((n) => n.id === node.id) + 1}`;
}

/** First problem that would stop a run, with the node to select. */
export function validate(nodes: FlowNode[], edges: Edge[]): { nodeId: string | null; message: string } | null {
  if (!nodes.some((n) => n.type !== "image")) return { nodeId: null, message: "Add a Generate node — it makes the images" };
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

/** A spot near `wanted` that doesn't overlap existing nodes. */
export function freeSpot(wanted: XYPosition, type: NodeType, nodes: FlowNode[]): XYPosition {
  const h = NODE_HEIGHT[type];
  const overlaps = (p: XYPosition) =>
    nodes.some((n) => {
      const nh = NODE_HEIGHT[n.type as NodeType] ?? 220;
      return p.x < n.position.x + NODE_WIDTH + 24 && p.x + NODE_WIDTH + 24 > n.position.x && p.y < n.position.y + nh + 24 && p.y + h + 24 > n.position.y;
    });
  let p = { ...wanted };
  for (let i = 0; i < 30 && overlaps(p); i++) p = { x: p.x + (i % 2 ? 0 : 36), y: p.y + 56 };
  return p;
}

export function nodeHeight(type: NodeType): number {
  return NODE_HEIGHT[type];
}
