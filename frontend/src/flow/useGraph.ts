// Editor state for one workflow: controlled React Flow nodes/edges, input order, undo/redo.
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
import type { Graph, NodeType } from "../lib/api";
import { toast } from "../components/ui";
import {
  connectionProblem,
  fromFlow,
  makeNode,
  newId,
  pruneEdges,
  syncInputs,
  toFlowEdges,
  toFlowNodes,
  type FlowNode,
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

  const isValidConnection = useCallback(
    (c: Connection | Edge) => connectionProblem(c.source, c.target, nodesRef.current, edgesRef.current) === null,
    [],
  );

  const connect = useCallback(
    (c: Connection) => {
      const problem = connectionProblem(c.source, c.target, nodesRef.current, edgesRef.current);
      if (problem) {
        toast(problem, { tone: "error" });
        return;
      }
      commit();
      setBoth(nodesRef.current, [...edgesRef.current, { id: newId("e"), source: c.source, target: c.target }]);
    },
    [commit, setBoth],
  );

  /** Adds a node (selected), optionally wired to an existing node. Returns its id. */
  const addNode = useCallback(
    (type: NodeType, position: XYPosition, opts: AddOptions = {}): string => {
      commit();
      const node = { ...makeNode(type, position, opts.data), selected: true } as FlowNode;
      const others = nodesRef.current.map((n) => (n.selected ? { ...n, selected: false } : n));
      const all = [...others, node];
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

  /** Copies the selected nodes (and connections into them) next to the originals, and selects the copies. */
  const duplicateSelected = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected);
    if (!selected.length) return;
    commit();
    const idMap = new Map(selected.map((n) => [n.id, newId()]));
    const copies = selected.map(
      (n) =>
        ({
          ...n,
          id: idMap.get(n.id)!,
          position: { x: n.position.x + 40, y: n.position.y + 40 },
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
    setBoth([...nodesRef.current.map((n) => (n.selected ? { ...n, selected: false } : n)), ...remapped], [...edgesRef.current, ...copiedEdges]);
  }, [commit, setBoth]);

  /** Selects one node (or none) without touching history. */
  const selectOnly = useCallback(
    (id: string | null) => {
      setBoth(
        nodesRef.current.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })),
        edgesRef.current.map((e) => (e.selected ? { ...e, selected: false } : e)),
      );
    },
    [setBoth],
  );

  return {
    nodes,
    edges,
    nodesRef,
    edgesRef,
    onNodesChange,
    onEdgesChange,
    onNodeDragStart,
    onConnect: connect,
    isValidConnection,
    addNode,
    updateData,
    removeNodes,
    duplicateSelected,
    selectOnly,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
