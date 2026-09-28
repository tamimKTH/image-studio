// Workflow files: export to a .studio.json download, read one back for import.
import { api } from "../lib/api";

export const WORKFLOW_FORMAT = "image-studio.workflow";

export const isWorkflowExport = (data: unknown): data is { format: string; name?: string } =>
  !!data && typeof data === "object" && (data as { format?: string }).format === WORKFLOW_FORMAT;

function fileName(name: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "workflow";
  return `${base}.studio.json`;
}

/** Downloads the workflow as `<name>.studio.json`. */
export async function exportWorkflowFile(id: string, name: string): Promise<void> {
  const data = await api.exportWorkflow(id);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copies the workflow to the clipboard, ready to paste on the Workflows page. */
export async function copyWorkflow(id: string): Promise<void> {
  const data = await api.exportWorkflow(id);
  await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
}

/** Reads a dropped or chosen file as an Image Studio workflow, with a plain message when it isn't one. */
export async function readWorkflowFile(file: File): Promise<unknown> {
  if (file.size > 20 * 1024 * 1024) throw new Error("That file is too large to be a workflow");
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(`“${file.name}” isn't a workflow file`);
  }
  if (!isWorkflowExport(data)) throw new Error(`“${file.name}” isn't an Image Studio workflow`);
  return data;
}

/** The first JSON-looking file in a drop, if any. */
export function jsonFileIn(files: FileList | null | undefined): File | null {
  if (!files) return null;
  return Array.from(files).find((f) => f.type === "application/json" || /\.json$/i.test(f.name)) ?? null;
}
