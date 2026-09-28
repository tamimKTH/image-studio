import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Toaster } from "./components/ui";
import { startEvents } from "./lib/events";
import { Activity } from "./pages/Activity";
import { Create } from "./pages/Create";
import { Library } from "./pages/Library";
import { Workflows } from "./pages/Workflows";

// The canvas (React Flow) is only loaded when a workflow or run is opened.
const WorkflowEditor = lazy(() => import("./pages/WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })));
const RunView = lazy(() => import("./pages/RunView").then((m) => ({ default: m.RunView })));

export function App() {
  useEffect(() => startEvents(), []);
  return (
    <BrowserRouter>
      <Shell>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Create />} />
            <Route path="/workflows" element={<Workflows />} />
            <Route path="/workflows/:id" element={<WorkflowEditor />} />
            <Route path="/runs/:id" element={<RunView />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/library" element={<Library />} />
            <Route path="*" element={<Create />} />
          </Routes>
        </Suspense>
      </Shell>
      <Toaster />
    </BrowserRouter>
  );
}
