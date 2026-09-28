// Saved save-destinations, shared by every folder picker.
import { useEffect } from "react";
import { create } from "zustand";
import { api, type Folder } from "./api";

interface FolderState {
  folders: Folder[];
  defaultFolder: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useFolderStore = create<FolderState>((set) => ({
  folders: [],
  defaultFolder: null,
  loaded: false,
  refresh: async () => {
    const [folders, settings] = await Promise.all([api.folders(), api.settings()]);
    set({ folders, defaultFolder: settings.defaultFolder, loaded: true });
  },
}));

/** Loads the folder list once and returns it. */
export function useFolders() {
  const state = useFolderStore();
  useEffect(() => {
    if (!state.loaded) state.refresh().catch(() => undefined);
  }, [state]);
  return state;
}

/** Adds (or re-uses) a folder as a save destination and refreshes the list. */
export async function rememberFolder(path: string, pinned?: boolean): Promise<Folder> {
  const folder = await api.addFolder(path, pinned);
  await useFolderStore.getState().refresh();
  return folder;
}
