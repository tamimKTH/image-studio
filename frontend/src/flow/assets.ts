// Asset lookups for image nodes: fetched once per id and shared by every node and panel.
import { useEffect } from "react";
import { create } from "zustand";
import { api, type Asset } from "../lib/api";

const useAssetStore = create<{ byId: Record<string, Asset | null> }>(() => ({ byId: {} }));
const pending = new Set<string>();

export function rememberAsset(asset: Asset) {
  useAssetStore.setState((s) => ({ byId: { ...s.byId, [asset.id]: asset } }));
}

/** The asset for an id (null while loading or when it no longer exists). */
export function useAsset(id: string | null | undefined): Asset | null {
  const asset = useAssetStore((s) => (id ? s.byId[id] : undefined));
  useEffect(() => {
    if (!id || asset !== undefined || pending.has(id)) return;
    pending.add(id);
    api
      .asset(id)
      .then(rememberAsset)
      .catch(() => useAssetStore.setState((s) => ({ byId: { ...s.byId, [id]: null } })))
      .finally(() => pending.delete(id));
  }, [id, asset]);
  return asset ?? null;
}
