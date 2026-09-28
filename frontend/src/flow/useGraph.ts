// Editor state for one workflow: controlled React Flow nodes/edges, input order, clipboard, undo/redo.
import { useCallback, useReducer, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import type { Graph, GraphEdge, GraphNode, NodeType } from "../lib/api";
import { toast } from "../components/ui";
import {
  boundsOf,
  connectionProblem,
  copySelection,
  freeSpot,
  fromFlow,
  makeNode,
  newId,
  pasteNodes,
  pruneEdges,
  syncInputs,
  toFlowEdges,
  toFlowNodes,
  type FlowNode,
  type NodeClipboard,
} from "./graph";

const HISTORY = 50;
const COALESCE_MS = 1200;

export interface AddOptions {
  data?: FlowNode["data"];
  /** Connect an existing node's output into the new node. */
  from?: string;
  /** Connect the new node's output into an existing node. */
  to?: string;
}

const deselect = <T extends { selected?: boolean }>(items: T[]) => items.map((i) => (i.selected ? { ...i, selected: false } : i));

export function useGraph(initial: Graph) {
  const [nodes, setNodesState] = useState<FlowNode[]>(() => syncInputs(toFlowNodes(initial.nodes), toFlowEdges(initial.edges)));
  const [edges, setEdgesState] = useState<Edge[]>(() => toFlowEdges(initial.edges));
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const past = useRef<Graph[]>([]);
  const future = useRef<Graph[]>([]);
  const lastKey = useRef<{ key: string; t: number } | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  /** The refs are the source of truth, so several changes in one tick compose correctly. */
  const setBoth = useCallback((n: FlowNode[], e: Edge[]) => {
    const pruned = pruneEdges(n, e);
    const synced = syncInputs(n, pruned);
    nodesRef.current = synced;
    edgesRef.current = pruned;
    setNodesState(synced);
    setEdgesState(pruned);
  }, []);

  /** Records the state before a change. Changes with the same key close together form one undo step. */
  const commit = useCallback((key?: string) => {
    const now = Date.now();
    if (key && lastKey.current?.key === key && now - lastKey.current.t < COALESCE_MS) {
      lastKey.current.t = now;
      return;
    }
    lastKey.current = key ? { key, t: now } : null;
    past.current.push(fromFlow(nodesRef.current, edgesRef.current));
    if (past.current.length > HISTORY) past.current.shift();
    future.current = [];
    bump();
  }, []);

  const restore = useCallback(
    (g: Graph) => {
      lastKey.current = null;
      setBoth(toFlowNodes(g.nodes), toFlowEdges(g.edges));
      bump();
    },
    [setBoth],
  );

  const undo = useCallback(() => {
    const g = past.current.pop();
    if (!g) return;
    future.current.push(fromFlow(nodesRef.current, edgesRef.current));
    restore(g);
  }, [restore]);

  const redo = useCallback(() => {
    const g = future.current.pop();
    if (!g) return;
    past.current.push(fromFlow(nodesRef.current, edgesRef.current));
    restore(g);
  }, [restore]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      if (changes.some((c) => c.type === "remove")) commit("delete");
      // A note being resized: one undo step for the whole drag.
      const resized = changes.find((c) => c.type === "dimensions" && c.resizing);
      if (resized && "id" in resized) commit(`resize:${resized.id}`);
      setBoth(applyNodeChanges(changes, nodesRef.current), edgesRef.current);
    },
    [commit, setBoth],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((c) => c.type === "remove")) commit("delete");
      setBoth(nodesRef.current, applyEdgeChanges(changes, edgesRef.current));
    },
    [commit, setBoth],
  );

  const onNodeDragStart = useCallback(() => commit(), [commit]);

  /** Adds source → target after checking it; shows why when it isn't allowed. Returns whether it was added. */
  const connect = useCallback(
    (c: Pick<Connection, "source" | "target">): boolean => {
      const problem = connectionProblem(c.source, c.target, nodesRef.current, edgesRef.current);
      if (problem) {
        toast(problem, { tone: "error" });
        return false;
      }
      commit();
      setBoth(nodesRef.current, [...edgesRef.current, { id: newId("e"), source: c.source, target: c.target }]);
      return true;
    },
    [commit, setBoth],
  );

  /** Moves an existing connection to new ends (the old connection doesn't count as "already connected"). */
  const reconnect = useCallback(
    (old: Edge, c: Pick<Connection, "source" | "target">): boolean => {
      if (old.source === c.source && old.target === c.target) return true;
      const others = edgesRef.current.filter((e) => e.id !== old.id);
      const problem = connectionProblem(c.source, c.target, nodesRef.current, others);
      if (problem) {
        toast(problem, { tone: "error" });
        return false;
      }
      commit();
      setBoth(nodesRef.current, [...others, { id: newId("e"), source: c.source, target: c.target }]);
      return true;
    },
    [commit, setBoth],
  );

  const removeEdge = useCallback(
    (id: string) => {
      if (!edgesRef.current.some((e) => e.id === id)) return;
      commit();
      setBoth(
        nodesRef.current,
        edgesRef.current.filter((e) => e.id !== id),
      );
    },
    [commit, setBoth],
  );

  /** Adds a node (selected), optionally wired to an existing node. Returns its id. */
  const addNode = useCallback(
    (type: NodeType, position: XYPosition, opts: AddOptions = {}): string => {
      commit();
      const node = { ...makeNode(type, position, opts.data), selected: true } as FlowNode;
      const all = [...deselect(nodesRef.current), node];
      const extra: Edge[] = [];
      for (const [source, target] of [
        [opts.from, node.id],
        [node.id, opts.to],
      ] as const) {
        if (!source || !target) continue;
        const problem = connectionProblem(source, target, all, [...edgesRef.current, ...extra]);
        if (problem) toast(problem, { tone: "error" });
        else extra.push({ id: newId("e"), source, target });
      }
      setBoth(all, [...edgesRef.current, ...extra]);
      return node.id;
    },
    [commit, setBoth],
  );

  const updateData = useCallback(
    (id: string, patch: Record<string, unknown>, key?: string) => {
      commit(key ?? `data:${id}:${Object.keys(patch).sort().join(",")}`);
      setBoth(
        nodesRef.current.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n)),
        edgesRef.current,
      );
    },
    [commit, setBoth],
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      commit();
      setBoth(
        nodesRef.current.filter((n) => !ids.includes(n.id)),
        edgesRef.current,
      );
    },
    [commit, setBoth],
  );

  /** Pastes clipboard nodes with their top-left at `at` (or the nearest free spot); the pasted nodes become the selection. */
  const paste = useCallback(
    (clip: { nodes: GraphNode[]; edges: GraphEdge[] }, at: XYPosition): number => {
      const pasted = pasteNodes(clip, at);
      if (!pasted.nodes.length) return 0;
      const spot = freeSpot(at, boundsOf(pasted.nodes), nodesRef.current);
      const moved = pasted.nodes.map((n) => ({ ...n, position: { x: n.position.x + spot.x - at.x, y: n.position.y + spot.y - at.y } }));
      commit();
      setBoth([...deselect(nodesRef.current), ...moved], [...deselect(edgesRef.current), ...pasted.edges]);
      return pasted.nodes.length;
    },
    [commit, setBoth],
  );

  /** The selection as clipboard data (nodes and the connections between them). */
  const copy = useCallback((): NodeClipboard | null => copySelection(nodesRef.current, edgesRef.current), []);

  const cut = useCallback((): NodeClipboard | null => {
    const clip = copySelection(nodesRef.current, edgesRef.current);
    if (clip) removeNodes(clip.nodes.map((n) => n.id));
    return clip;
  }, [removeNodes]);

  /** Copies the selected nodes (and connections into them) to free space next to the originals, and selects the copies. */
  const duplicateSelected = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected);
    if (!selected.length) return;
    commit();
    const box = boundsOf(selected);
    const spot = freeSpot(box, box, nodesRef.current);
    const idMap = new Map(selected.map((n) => [n.id, newId()]));
    const copies = selected.map(
      (n) =>
        ({
          ...n,
          id: idMap.get(n.id)!,
          position: { x: n.position.x + spot.x - box.x, y: n.position.y + spot.y - box.y },
          data: structuredClone(n.data),
          selected: true,
        }) as FlowNode,
    );
    const copiedEdges: Edge[] = edgesRef.current
      .filter((e) => idMap.has(e.target))
      .map((e) => ({ id: newId("e"), source: idMap.get(e.source) ?? e.source, target: idMap.get(e.target)! }));
    const remapped = copies.map((n) =>
      n.type === "generate" ? ({ ...n, data: { ...n.data, inputs: n.data.inputs.map((i) => idMap.get(i) ?? i) } } as FlowNode) : n,
    );
    setBoth([...deselect(nodesRef.current), ...remapped], [...deselect(edgesRef.current), ...copiedEdges]);
  }, [commit, setBoth]);

  /** Selects one node (or none) without touching history. */
  const selectOnly = useCallback(
    (id: string | null) => {
      setBoth(
        nodesRef.current.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })),
        deselect(edgesRef.current),
      );
    },
    [setBoth],
  );

  const selectAll = useCallback(() => {
    setBoth(
      nodesRef.current.map((n) => (n.selected ? n : { ...n, selected: true })),
      edgesRef.current,
    );
  }, [setBoth]);

  return {
    nodes,
    edges,
    nodesRef,
    edgesRef,
    onNodesChange,
    onEdgesChange,
    onNodeDragStart,
    connect,
    reconnect,
    removeEdge,
    addNode,
    updateData,
    removeNodes,
    paste,
    copy,
    cut,
    duplicateSelected,
    selectOnly,
    selectAll,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
