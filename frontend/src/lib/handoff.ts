// Hands images (and optionally a prompt) to the Create screen, e.g. "Use as input" from a result.
import { create } from "zustand";
import type { Asset } from "./api";

interface Handoff {
  images: Asset[];
  prompt: string | null;
  seq: number;
}

export const useHandoff = create<Handoff>(() => ({ images: [], prompt: null, seq: 0 }));

/** Queue images for Create; navigate to "/" afterwards. */
export function sendToCreate(images: Asset[], prompt: string | null = null) {
  useHandoff.setState((s) => ({ images, prompt, seq: s.seq + 1 }));
}

/** Create calls this once to take what was handed over. */
export function takeHandoff(): { images: Asset[]; prompt: string | null } {
  const { images, prompt } = useHandoff.getState();
  useHandoff.setState({ images: [], prompt: null });
  return { images, prompt };
}
