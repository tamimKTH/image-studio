// Lightbox for a node's results, with "Use in Create" and "Delete" (Undo restores the file).
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Trash2 } from "lucide-react";
import { api, type NodeState, type OutputImage } from "../lib/api";
import { sendToCreate } from "../lib/handoff";
import { Lightbox } from "../components/media/Lightbox";
import { Button, toast } from "../components/ui";

/** Results deleted on this page stay hidden (on the nodes and in lists) until Undo brings them back. */
export function useDeletedOutputs() {
  const [deleted, setDeleted] = useState<string[]>([]);
  const onRemoved = useCallback(
    (path: string, removed: boolean) => setDeleted((d) => (removed ? (d.includes(path) ? d : [...d, path]) : d.filter((p) => p !== path))),
    [],
  );
  const hide = useCallback(
    (states: Record<string, NodeState> | null): Record<string, NodeState> | null => {
      if (!states || !deleted.length) return states;
      return Object.fromEntries(Object.entries(states).map(([id, st]) => [id, { ...st, outputs: st.outputs.filter((o) => !deleted.includes(o.path)) }]));
    },
    [deleted],
  );
  return { onRemoved, hide };
}

interface Props {
  outputs: OutputImage[];
  index: number | null;
  onIndex: (index: number | null) => void;
  /** A result was deleted (true) or brought back with Undo (false). */
  onRemoved?: (path: string, removed: boolean) => void;
}

export function OutputLightbox({ outputs, index, onIndex, onRemoved }: Props) {
  const navigate = useNavigate();
  const items = outputs.map((o) => ({ url: o.url, path: o.path, name: o.name }));

  async function useInCreate(output: OutputImage) {
    try {
      const asset = await api.asset(output.id);
      sendToCreate([asset]);
      onIndex(null);
      navigate("/");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  async function remove(output: OutputImage) {
    try {
      const { id } = await api.trash(output.path);
      onIndex(null);
      onRemoved?.(output.path, true);
      toast("Deleted", {
        action: {
          label: "Undo",
          onClick: () =>
            api
              .restore(id)
              .then(() => {
                onRemoved?.(output.path, false);
                toast("Restored");
              })
              .catch((e: Error) => toast(e.message, { tone: "error" })),
        },
      });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }

  return (
    <Lightbox
      items={items}
      index={index}
      onIndex={onIndex}
      actions={(item) => {
        const output = outputs.find((o) => o.path === item.path);
        if (!output) return null;
        return (
          <>
            <Button variant="primary" icon={<Sparkles size={16} />} onClick={() => useInCreate(output)}>
              Use in Create
            </Button>
            <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => remove(output)}>
              Delete
            </Button>
          </>
        );
      }}
    />
  );
}
