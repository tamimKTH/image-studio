# Plan: Image Studio (from intent.md 2026-09-28)

## Files that change
All paths are relative to `~/Desktop/majed/image-studio` unless stated.

**Project root and engine**
- `studio` (new): the CLI for setup, start, stop, status, logs and open.
- `docker-compose.yml`, `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md` (new)
- `engine/setup.sh`, `engine/dequantize.py` (new; already proven)
- `backend/app/prompts/pe_t2i.txt`, `backend/app/prompts/pe_i2i.txt` (new): the official PE system prompts, used by the backend to build enhancer graphs.

**Backend** (new files under `backend/`)
- `requirements.txt`
- `app/__init__.py`
- `app/main.py`: the app, lifespan, static files.
- `app/config.py`: paths and constants.
- `app/db.py`: the SQLite schema and helpers.
- `app/events.py`: the SSE broker.
- `app/engine.py`: the ComfyUI client (HTTP, WebSocket and previews).
- `app/graphs.py`: prompt graphs and sizes.
- `app/files.py`: folders, safe paths, thumbnails, saving, trash.
- `app/executor.py`: runs, the DAG, cancel, retry, idle unload.
- `app/starters.py`: the starter workflows.
- `app/api.py`: all routes.

**Frontend** (new files under `frontend/`)
- Setup: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Entry and shared code: `src/main.tsx`, `src/App.tsx`, `src/styles/tokens.css`, `src/lib/{api.ts,events.ts,format.ts,prefs.ts}`
- Components:
  - `src/components/ui/{index.tsx,ui.module.css}` (the primitives)
  - `src/components/Shell.tsx`
  - `src/components/folders/{FolderPicker,FolderBrowser}.tsx`
  - `src/components/composer/{PromptBox,ImageStrip,OptionsBar,MoreSettings,MarkArea}.tsx`
  - `src/components/media/{ImageCard,Lightbox,RunResults}.tsx`
  - CSS modules next to each group
- Shared code: `src/lib/{folders,handoff}.ts`, alongside `api`, `events`, `format` and `prefs`.
- Pages: `src/pages/{Create,CreateRun,Library,Activity,RunView,Workflows,WorkflowEditor}.tsx`, each with its CSS module.
- Canvas: `src/flow/{graph.ts,useGraph.ts,nodes.tsx,NodePanel.tsx,DropMenu.tsx,OutputLightbox.tsx,assets.ts,flow.module.css}`

**Departures from this plan during the build** (all recorded here):
- The Checker component became a global `.checker` class.
- `RunResults.tsx` is shared by Create and the Create run view.
- The canvas split into more files.
- `App.tsx` lazy-loads the editor and the run view, which keeps the main bundle at 357 kB.
- `./studio` waits for `launchctl bootout` to finish, because a bootstrap straight after it left the engine unloaded.

**Outside the project**
- `~/Library/LaunchAgents/com.majed.imagestudio.engine.plist` (written by `./studio setup`)
- `~/ComfyUI-Shared/models/text_encoders/*.dequant-bf16.safetensors` (3 files, made by `dequantize.py`)

## Order of work
1. **Engine, proven by hand:** t2i, edit with 2 images, transparent, remove background, PE-T2I and PE-I2I all work through the API. Done: sheets in the scratchpad.
2. **`studio` CLI and launchd agent:** `./studio setup` leaves the engine answering on :8199 after `launchctl kickstart`.
3. **Frontend foundation (single author):** tokens, primitives, api client and types, events store, shell, folder picker and browser, composer, lightbox. `npm run build` passes.
4. **In parallel,** with disjoint files:
   - (a) the backend (`backend/**`);
   - (b) Create, Library, Activity and the create run view;
   - (c) the Workflows list, editor, canvas and run view.
   Each leaf proves its own part: the backend with a scratch smoke script against the live engine, the frontend with `tsc` and `vite build`.
5. **Docker:** the image builds; `docker compose up -d` serves :4747; the container reaches the engine.
6. **End to end in the browser** (efficient-ui-testing):
   - Create t2i, Create with 2 images, transparent, remove background, Improve.
   - Save to a new folder made with Browse.
   - A workflow chain of 2 generate nodes, run twice at once; open the Activity view mid-run; cancel; run again.
   - Duplicate, copy, paste and delete a workflow.
7. **Review and land:** verifier, simplifier and reviewer, fixing what they find, then commit. Also remove the test leftovers in Majed-Flo (done).

## Risks
- **The engine is slow when models are loaded cold** (about 40 s the first time). The UI shows "Loading model…" on the first step.
- **SSE through Docker port forwarding:** proxies can buffer. FastAPI's `StreamingResponse` with no-cache headers and 15 s heartbeats avoids that.
- **Riskiest step: 4c, the canvas.** React Flow ordering of multiple inputs is solved with an explicit `inputs` order on the node, not with edge order.
- **Engine restart mid-run:** the WebSocket reconnect polls `/history` for prompts in flight; a prompt lost in the restart fails its node after 30 s without the engine knowing it.
- **Memory with the enhancer loaded:** idle unload after 10 minutes, and `/free` before a 2K batch is not done (not needed at 128 GB).

**Options not taken**
- ComfyUI inside Docker: no GPU there, so CPU-only generation would take minutes per step.
- diffusers: no GGUF path for Qwen-Image 2.1 on MPS was proven.
- Comfy Desktop's server as the engine: it depends on the app being open, and its install would be changed.
- A LaunchAgent that reads `~/Desktop`: blocked by macOS privacy.

## Proof
- `./studio status` → `engine: online (mps)`, `app: running on http://127.0.0.1:4747`
- `curl -s localhost:4747/api/status` → `engine.online=true`, and every model flag true
- **Create "A neon sign that says OPEN, rainy night" (defaults):** a PNG appears in `~/Pictures/Image Studio` within 3 minutes, and `studio` metadata is present.
- **Create with 2 images and "Put image 2 on the table in image 1":** the output keeps image 1's framing and contains image 2's object.
- **Transparent on "a red teapot":** the PNG mode is RGBA, and more than 30% of its pixels are transparent.
- **Remove background on a photo:** an RGBA PNG with the subject kept.
- **✨ Improve:** the prompt is rewritten in under 60 s, and the aspect chip changes when a ratio is suggested.
- **Folder browser:** New folder "Studio Test" under Pictures → chosen → the next image is saved there, and it is listed in Library.
- **Two workflow runs at once:** Activity shows both, the current step advances live, and opening one shows node states.
- **Cancel** stops within a few seconds; **Retry** on a canceled run reuses the done nodes.
- **Workflows:** duplicate → "… copy" appears; copy then ⌘V → an imported copy appears; delete → Undo restores it.
- **Browser reload mid-run:** the progress is still shown, and the run completes.

## Round 2 (Majed's follow-up and the review findings, 2026-09-29)

**Files that change** (paths from the repo root)
- `frontend/src/lib/keys.ts` (new): ⌘-or-Ctrl shortcuts and platform hints.
- `frontend/src/flow/transfer.ts` (new): export and import files, copy and paste of workflows.
- Edited:
  - `frontend/src/lib/{api,prefs}.ts` and `frontend/src/styles/tokens.css`: note node type, run numbers, options, restore, `useResolvedTheme`, `color-scheme` per theme.
  - `frontend/src/flow/*`, `pages/{WorkflowEditor,Workflows,RunView}.tsx`: notes, box selection, copy/cut/paste/duplicate, edge selection and reconnect, export/import, placement and reveal, colour mode.
  - `frontend/src/components/**` and `pages/{Create,CreateRun,Library,Activity}.tsx`: theme fixes, the theme menu, engine options, Delete with Undo, Undo improve, run numbers, progress labels.
  - `backend/app/{main,config,db,files,executor,graphs,api,starters}.py`:
    - host and origin checks, and no framing;
    - case-insensitive Library check, and node save folders validated;
    - app trash with restore, plus an hourly 30-day purge;
    - JSON 500s and HEIC;
    - `/api/options`;
    - `ratio_follow` for any image;
    - dropped variations on failure or cancel;
    - remove-background quality;
    - hidden macOS packages;
    - empty Blank starter;
    - unique names and run numbers;
    - upload dedupe with original names;
    - note nodes skipped;
    - `retry {fresh}`.
- New dependency: `pillow-heif==1.8.0` (`backend/requirements.txt`).
- New table: `trash(id, original_path, trash_path, created_at)` in `studio.db`.
- New settings:
  - `STUDIO_APP_DIR`, `STUDIO_INSTANCE` and `STUDIO_IDLE_MINUTES` let a development backend share the engine without touching the app's data or queue.
  - `STUDIO_API` sets the Vite proxy target.
- `.gitignore`: `.playwright-cli/`.

**Order of work**
1. Contract first (types, keys, themes, dev settings).
2. Three leaves in parallel on separate files: backend, canvas and screens. Each tested on its own dev backend and Vite, never the running app.
3. Integration, and a rebuild only while no run is active.
4. A browser pass on the live app.
5. Re-review.

**Risks**
- **Rebuilding interrupts runs.** Every rebuild checked `/api/runs` for active work first.
- **The engine is shared between the app and dev backends.** Instance subfolders keep their files apart. Only the main instance clears the engine queue after a restart, and dev backends never unload models.
- **DNS rebinding against the engine on :8199** is not closed by the app's middleware. The 127.0.0.1 binding and the browser's local-network protections remain the guards.

**Proof (round 2)**
- **Delete and Undo in Docker:** the file leaves its folder, appears in `…/ImageStudio/trash`, and Undo restores it.
- **Connections:** connect 2 images to Generate, click a connection, press Delete (1 left), reconnect (2 again); the saved `inputs` hold both images.
- **Box selection:** select 4 nodes, then Ctrl+C and Ctrl+V give 8 nodes with 4 connections; Ctrl+Z gives 4.
- **Notes:** the text, colour and size are saved; in a run view the note is read-only.
- **Export and import:** Export gives `<name>.studio.json`; Import (file) opens "<name> copy" with the same nodes, connections and images.
- **Placement:** Image, Image, Generate, Remove background and Note from the toolbar go in a flow layout, all visible, with no overlaps.
- **Themes:**
  - Light, Dark and System (OS light and OS dark) give backgrounds `rgb(246,246,248)` and `rgb(13,13,17)`.
  - `color-scheme` follows the theme, and React Flow gets its dark class.
- **Security:**
  - A foreign Host → 400, and a foreign or cross-port Origin on a POST → 403.
  - `~/LIBRARY` in any letter case → 403.
  - A node save folder in `~/.ssh` → 400.
  - Pages carry `X-Frame-Options: DENY`.
- **Run again vs Retry:** Run again on a finished run makes new images from that run's own graph; Retry on a canceled run keeps the finished nodes.
- **Options:** `/api/options` equals the More menus (45 samplers, 9 schedulers). A non-default choice reaches the PNG metadata.
