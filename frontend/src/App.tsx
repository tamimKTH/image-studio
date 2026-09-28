import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Toaster } from "./components/ui";
import { startEvents } from "./lib/events";
import { Activity } from "./pages/Activity";
import { Create } from "./pages/Create";
import { Library } from "./pages/Library";
import { RunView } from "./pages/RunView";
import { WorkflowEditor } from "./pages/WorkflowEditor";
import { Workflows } from "./pages/Workflows";

export function App() {
  useEffect(() => startEvents(), []);
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Create />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/workflows/:id" element={<WorkflowEditor />} />
          <Route path="/runs/:id" element={<RunView />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/library" element={<Library />} />
          <Route path="*" element={<Create />} />
        </Routes>
      </Shell>
      <Toaster />
    </BrowserRouter>
  );
}
