import type { RunDetail } from "../lib/api";

/** Results view for a Create run (owned by the Create/Library/Activity leaf). */
export function CreateRunView({ run }: { run: RunDetail }) {
  return <div style={{ padding: 32 }}>{run.name}</div>;
}
