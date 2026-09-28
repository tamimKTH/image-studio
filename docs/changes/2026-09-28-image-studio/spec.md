# Spec: Image Studio (from intent.md 2026-09-28)

## What changes for Majed
Open `http://localhost:4747`. Four places, always one click away:

- **Create**: one prompt box. Type what you want, drop images to edit or combine them, press **Generate** (⌘↵). The image forms live and is saved in the folder shown under the box.
- **Workflows**: an n8n-style canvas. Image nodes and Generate nodes are joined with lines, and each Generate node's result can feed the next one. You can run, edit, duplicate, copy, paste and delete workflows.
- **Activity**: every run, running or finished, with live progress. Click one to see how far it got, node by node.
- **Library**: the folders the app saves to, with their images. You can browse the Mac, create a folder and make it a save destination.

## UX simplicity principles (the rules every screen follows)
1. **One primary action per screen.** Create → *Generate*; Workflow → *Run*. It is the only filled button.
2. **The prompt is the only required field.** Every other setting has a working default.
3. **Progressive disclosure.** Rarely used settings live behind **More**, and are never shown by default.
4. **Recognition over recall.** Current values are visible chips; folders are named places with previews, not typed paths.
5. **Direct manipulation.** Drag images in, drag to reorder inputs, drag to connect nodes.
6. **Calm, immediate feedback.** Everything that runs shows a live preview, step count and progress; nothing blocks the screen.
7. **Forgiving.** Undo and redo in the editor; delete shows an Undo toast; deleted images go to the Mac Trash.
8. **Consistency.** The same prompt box, option chips and folder picker are used in Create and in the node panel.
9. **Little chrome.** Four navigation items; menus are at most one level deep; no settings page.
10. **Accessible.** Keyboard shortcuts, visible focus, WCAG AA contrast, `prefers-reduced-motion` and `prefers-color-scheme` respected.

## Model capabilities exposed (Qwen-Image 2.1, verified on this Mac 2026-09-28)

| Capability | How it appears in the UI | Engine detail |
|---|---|---|
| **Text-to-image, native to 2K** | Aspect chip; Size chip 1K / 2K | `EmptyLatentImage` sizes below |
| **Edit with up to 10 reference images** | Drop images; they are numbered 1, 2, 3; write "image 2" or `<image2>` in the prompt | `TextEncodeQwenImage21` with `vae` and `images.image_N` |
| **Output follows image 1 in edits** | Aspect chip shows **Match image 1** (default in edits) | Latent from encoder output 2 |
| **Transparent PNG** | Transparent toggle | Official RGBA prompt wrapper; alpha is kept |
| **Background removal / subject extraction** | "Remove background" quick action and node | Edit prompt `Remove the background, and output a PNG image` |
| **Transparent-layer editing** | RGBA inputs keep their alpha | `LoadImage` → `JoinImageWithAlpha` |
| **Marked-area edits** (circle, paint, or a separate mask) | Mark area on any input image: brush or circle, or "as mask" | Annotated image, or a mask added as an extra reference |
| **Prompt enhancer** (official PE-T2I / PE-I2I) | ✨ Improve button; Auto-improve toggle on nodes | `TextGenerate` with the model's system prompt; the suggested aspect ratio is applied |
| **Typography** | Tip in the empty state: text in "double quotes" | – |
| **Negative prompt** | More → Avoid (sets guidance 4 automatically) | CFG > 1 needed; about 2× slower |
| **Seed, steps, guidance, sampler, scheduler, reference detail** | More | `KSampler`, `resolution` |
| **Variations** | ×1–4 chip | N prompts with seeds s…s+N−1 |

**Sizes (w×h, multiples of 32).**

| Aspect | 2K (official table) | 1K (about 1 MP) |
|---|---|---|
| 1:1 | 2048×2048 | 1024×1024 |
| 4:3 | 2400×1792 | 1184×896 |
| 3:4 | 1792×2400 | 896×1184 |
| 3:2 | 2528×1696 | 1248×832 |
| 2:3 | 1696×2528 | 832×1248 |
| 16:9 | 2752×1536 | 1376×768 |
| 9:16 | 1536×2752 | 768×1376 |

- **Edits (Match image 1):** `resolution` = 1024 (1K) or 2048 (2K).
- **Quality:** Fast 16 steps, Standard 28 (default), Best 40 (the official pipeline uses 40–50).
- **Transparent wrapper, text-to-image:** `This is an RGBA image with transparency. {prompt}. The image has alpha channel and the background is transparent.`
- **Transparent, edits:** append `Output a PNG image with a transparent background.`
- **Prompt references:** `image N`, `image N` / `img N` / `picture N` (with or without a space) become `<imageN>` when N ≤ the number of inputs.

## Architecture
```
Browser ──http://127.0.0.1:4747──▶ Docker container "image-studio"
                                     FastAPI + static React build, SQLite
                                     │  HTTP + WebSocket
                                     ▼
              http://host.docker.internal:8199 ── native engine (launchd agent)
                                     ComfyUI v0.37.4 + ComfyUI-GGUF (leejet@373048b)
                                     Apple GPU; VAE on CPU (MPS VAE encode is broken)
```
- **Runtime folder:** `~/Library/Application Support/ImageStudio/`.
  - `engine/`: ComfyUI and its `.venv`, installed by `engine/setup.sh`.
  - `io/{input,output,temp,user}`: the engine's working folders.
  - `app/`: `studio.db`, `uploads/`, `thumbs/`.
  - `logs/`.
- **The engine is not on `~/Desktop`,** because launchd agents cannot read Desktop without a privacy prompt.
- **Container mounts** `${HOME}` and `/Volumes` at the same absolute paths, read-write. Paths are therefore identical inside and outside the container, and the folder browser shows real Mac paths.
- **Engine flags:** `--listen 127.0.0.1 --port 8199 --gpu-only --cpu-vae --preview-method latent2rgb --preview-size 384 --disable-api-nodes --disable-auto-launch`, plus the model-paths yaml and the `io/*` folders.
- **Why these flags:**
  - `--gpu-only` puts the text encoders on the GPU, which makes edits about 35% faster and the enhancer usable (11 tokens/s).
  - `--cpu-vae` is needed because a VAE round trip on MPS is corrupted (mean error 54/255, versus 1.8 on the CPU).
- **Model files** in `~/ComfyUI-Shared/models`:
  - `diffusion_models/qwen-image-2.1-UC-Q8_0.gguf`
  - `text_encoders/qwen3vl_8b.dequant-bf16.safetensors`
  - `vae/qwen_image_2.1_vae_bf16.safetensors`
  - `text_encoders/qwen3.5_9b_qwen_image_2.1_pe_{t2i,i2i}.dequant-bf16.safetensors`
- **Why dequantized files:** the `.dequant-bf16` files are made by `engine/dequantize.py` from the official int8_convrot files. PyTorch has no int8 matmul (`aten::_int_mm`) on MPS, so the int8 files cannot run on the GPU.
- **Enhancer system prompts** ship in `backend/app/prompts/pe_{t2i,i2i}.txt`, copied from `Qwen/Qwen-Image-2.1-PE-*`.

## Requirements
- **R1:** `./studio setup` installs the engine, converts missing bf16 files, installs the launchd agent and starts the Docker app; `./studio start|stop|status|logs|open` manage both parts. The command is safe to run again.
- **R2:** Create generates from a prompt alone with defaults (Standard, 1:1, 1K, ×1) and saves a PNG into the default folder `~/Pictures/Image Studio`.
- **R3:** Create accepts 1–10 images (drop, paste, pick, or from the Library). They are numbered by position and can be reordered by dragging. The prompt can refer to them by number.
- **R4:** The Transparent toggle produces a PNG with real alpha. Remove background produces a cut-out PNG.
- **R5:** Mark area on an input produces an annotated copy, or a mask as an extra input. The original is untouched.
- **R6:** ✨ Improve rewrites the prompt with PE-T2I (no images) or PE-I2I (with images), shows the result in place with Undo, and applies the suggested aspect. It takes about 30–40 s.
- **R7:** The folder picker lists saved folders (pinned first, then recent) with image counts. Browse Mac… lets the user walk folders under the home folder and `/Volumes`, create a folder and choose it. The choice becomes a saved folder.
- **R8:** The workflow canvas supports Image, Generate and Remove-background nodes. Connections are drag-to-connect; a Generate node takes 0–10 ordered inputs. Nodes can be added from the toolbar or by dropping a connection on empty canvas. The canvas has undo and redo, autosaves, and rejects cycles.
- **R9:** Workflows can be created (blank or from 3 starters), renamed, duplicated, copied as JSON to the clipboard, pasted or imported, deleted with Undo, and run.
- **R10:** Several runs, from Create and from workflows, can be active at once. The engine processes them first in, first out, and each run keeps its own progress. Runs continue when the browser is closed.
- **R11:** Activity lists running runs first, with live progress: images done / total, current node step x/y, and a live preview. Opening a run shows the canvas with each node's state and results.
- **R12:** A failed node skips the nodes downstream of it, while other branches finish. Cancel stops queued and running work. Run again copies the run; results that are already done are reused.
- **R13:** Every saved image has its prompt and settings in PNG text metadata, and appears in the Library of its folder.
- **R14:** The engine status is always visible: online, working or offline, with a one-line fix. If the engine is offline, generation waits and resumes.
- **R15:** After 10 minutes idle the backend asks the engine to unload models, which frees about 40 GB of RAM.
- **R16:** File APIs only read and write under `${HOME}` or `/Volumes`, never in hidden folders or `~/Library`. The only exception is the app's own runtime folder. The app listens only on 127.0.0.1.

## Design: data
SQLite `studio.db`. All ids are 12-character url-safe random strings; all times are unix seconds (float).

**Tables**
- `settings(key PK, value JSON)`: `defaultFolder`.
- `folders(id PK, path UNIQUE, name, pinned INT, last_used_at, created_at)`
- `assets(id PK, path, kind 'upload'|'generated'|'file', width, height, has_alpha INT, created_at, meta JSON)`
- `workflows(id PK, name, graph JSON, folder NULL, created_at, updated_at)`
- `runs(id PK, kind 'create'|'workflow', workflow_id NULL, name, graph JSON, folder, status, total INT, done INT, created_at, started_at, finished_at, error)`
- `run_nodes(run_id, node_id, status, progress REAL, step INT, steps INT, outputs JSON, error, started_at, finished_at, PK(run_id,node_id))`

**Graph** (the same shape for workflows and runs, and the same shape React Flow uses):
```json
{"nodes": [
  {"id": "a1", "type": "image", "position": {"x": 0, "y": 0}, "data": {"asset": "<assetId>"}},
  {"id": "g1", "type": "generate", "position": {"x": 320, "y": 0}, "data": {
     "prompt": "Put image 2 on the table in image 1", "inputs": ["a1", "a2"],
     "aspect": "auto", "size": "1k", "quality": "standard", "count": 1, "transparent": false,
     "autoImprove": false, "folder": null,
     "advanced": {"seed": null, "negative": "", "cfg": null, "steps": null,
                  "sampler": "euler", "scheduler": "simple", "refDetail": "standard"}}},
  {"id": "r1", "type": "removeBackground", "position": {"x": 640, "y": 0}, "data": {"folder": null}}],
 "edges": [{"id": "e1", "source": "a1", "target": "g1"}]}
```
- **Field values:**
  - `aspect`: `auto` (match image 1; for text-to-image this means 1:1) or one of `1:1 4:3 3:4 3:2 2:3 16:9 9:16`.
  - `size`: `1k` or `2k`.
  - `quality`: `fast`, `standard` or `best`.
  - `refDetail`: `standard` (1024), `high` (2048) or `original` (0).
  - `inputs`: the order of the Generate node's inputs. Sources connected by an edge but missing from `inputs` are appended in edge order.
- **Outputs:** a node's outputs are asset ids. Downstream nodes use the first output.
- **Statuses:**
  - Run: `queued → running → done | failed | canceled`.
  - Node: `waiting → queued → running → done | failed | skipped | canceled`.
  - Image nodes are `done` at start.

## Design: HTTP API (JSON; errors are `{"error": "..."}` with 4xx/5xx)
- **Status and settings**
  - `GET /api/status` → `{engine:{online,device,queue,version,error}, models:{generator,textEncoder,vae,enhancerT2I,enhancerI2I} (booleans), defaultFolder}`
  - `GET/PUT /api/settings` `{defaultFolder}`
- **Mac folders and files**
  - `GET /api/fs?path=` → `{path, name, parent, crumbs:[{name,path}], dirs:[{name,path}], places:[{name,path,kind}]}`. Without `path` it returns the home folder.
  - `POST /api/fs/folder {parent,name}` → `{path}`
  - `GET /api/folders` → `[{id,path,name,pinned,count,cover,exists,lastUsedAt}]`
  - `POST /api/folders {path,pinned?}` (upsert)
  - `PATCH /api/folders/{id} {pinned?,name?}`
  - `DELETE /api/folders/{id}` (forgets it; the folder stays on disk)
  - `GET /api/folders/images?path=&offset=&limit=` → `{items:[{path,name,mtime,width,height,thumb,url}], total}`, newest first
  - `GET /api/file?path=` (the image), `GET /api/thumb?path=` (512 px WebP, cached)
  - `POST /api/files/trash {path}` (moves the file to `~/.Trash`)
  - `GET /api/files/info?path=` → `{path,name,width,height,bytes,mtime,meta}`, where `meta` is the PNG `studio` JSON or null
- **Assets**
  - `POST /api/assets/upload` (multipart `files`, optional `meta`) → `[{id,url,thumb,width,height,hasAlpha,name}]`
  - `POST /api/assets/from-path {path}` → asset
  - `GET /api/assets/{id}` → asset (`url` = `/api/file?path=…`)
- **Generation**
  - `POST /api/create {prompt, images:[assetId], aspect,size,quality,count,transparent,folder,advanced}` → `{runId}`
  - `POST /api/remove-background {asset, folder?}` → `{runId}`
  - `POST /api/enhance {prompt, images:[assetId]}` → `{prompt, aspect|null, matchImage:bool}`
- **Workflows**
  - `GET /api/workflows` → `[{id,name,updatedAt,nodeCount,cover,lastRun:{id,status,total,done}|null}]`
  - `POST /api/workflows {name?,graph?,folder?,starter?:"blank"|"combine"|"cutout"}` → workflow
  - `GET/PUT/DELETE /api/workflows/{id}` (the workflow is `{id,name,graph,folder,createdAt,updatedAt}`)
  - `POST /api/workflows/{id}/duplicate` → workflow
  - `GET /api/workflows/{id}/export` → `{format:"image-studio.workflow",version:1,name,graph,folder,assets:{id:path}}`
  - `POST /api/workflows/import` (the export JSON) → workflow
  - `POST /api/workflows/{id}/run` → `{runId}`
- **Runs**
  - `GET /api/runs?limit=` → `[RunSummary]`, where `RunSummary = {id,kind,workflowId,name,status,total,done,progress,createdAt,startedAt,finishedAt,error,thumbs:[url],current:{nodeId,step,steps}|null}`
  - `GET /api/runs/{id}` → `RunSummary + {graph, folder, nodes:{nodeId:{status,progress,step,steps,error,outputs:[{id,url,thumb,path,name}]}}}`
  - `POST /api/runs/{id}/cancel`
  - `POST /api/runs/{id}/retry` → `{runId}`
  - `DELETE /api/runs/{id}` (removes it from the history; the images stay)
- **Live events:** `GET /api/events` (Server-Sent Events). Events:
  - `run` (RunSummary)
  - `node` `{runId,nodeId,status,progress,step,steps,error,outputs?}`
  - `preview` `{runId,nodeId,image:"data:image/jpeg;base64,…"}` (at most 3 per second per node)
  - `engine` (the `status.engine` payload)
  - `folder` `{path}` (a folder's contents changed)

## Design: execution
1. **Create and workflow runs are the same.** Create builds a small graph (one image node per input and one Generate node) and runs it.
2. **Starting a run:** the backend snapshots the graph and checks it: no cycles; every Generate node has a prompt; every Image node has an asset; Remove background has exactly 1 input. Then it marks the Image nodes done and submits every node whose inputs are done.
3. **Submitting a Generate node:**
   1. Copy its inputs to `io/input/studio/<uuid>.png`.
   2. Optionally run the enhancer first.
   3. Build N prompts (one per variation) and POST them to `/prompt` with the backend's `client_id`.
   4. Map each `prompt_id` to `(run, node, index)`.
4. **Reading engine events (WebSocket):**
   - `progress` updates the node step.
   - A type-4 binary frame carries a preview.
   - `execution_success` collects the files from `io/output/studio/…`.
   - `execution_error` fails the node.
   - When the WebSocket reconnects, the backend polls `/history/<id>` for every prompt still in flight.
5. **Saving a result:**
   - Keep alpha only if some pixel has alpha below 250 and (transparent was requested, or an input had alpha, or the node is Remove background). Otherwise save RGB.
   - Write the PNG to the folder chosen in this order: node folder, then run folder, then the default folder.
   - Name it `<slug(prompt,40)>-<YYYYMMDD-HHMMSS>-<seed>.png`, adding a suffix on collision.
   - Write metadata `studio` = JSON {prompt, seed, steps, cfg, size, sampler, scheduler, inputs, model}.
   - Create an asset and a thumbnail, and delete the engine's copy.
6. **When a node finishes,** its downstream nodes are submitted. On failure, its dependants are `skipped`. The run ends when nothing is left to run.
7. **Cancel:** queued prompts are deleted with `POST /queue {delete:[ids]}`; running prompts are stopped with `POST /interrupt {prompt_id}`.
8. **Backend restart:** runs that were active are marked failed with "Interrupted by an app restart"; Run again resumes them.
9. **Prompt graphs** (API format):
   - The loaders are `UnetLoaderGGUF`, `CLIPLoader(type qwen_image)` and `VAELoader`, then `QwenImage21Cache(auto, default)` on the model.
   - Text-to-image: `EmptyLatentImage`. Edit: the encoder's latent output (or `EmptyLatentImage` if an explicit aspect is chosen).
   - Then `KSampler`, `VAEDecode` and `SaveImage(prefix studio/<run>_<node>_<k>)`.
   - Enhancer: `CLIPLoader(pe file, stable_diffusion)`, `PrimitiveStringMultiline(system prompt)`, `TextGenerate(thinking false, sampling on: temperature 1.0, top_k 20, top_p 0.95, min_p 0, repetition_penalty 1.0, max_length 4096)`, then `PreviewAny`.
     - For PE-I2I, the inputs are scaled to 0.6 MP each and batched with `ImageBatch`.
     - The user text for PE-I2I gets `\n\n(The user instruction is written in English.)` appended. This keeps the description in English; text rendered inside the image keeps its own language.
     - The JSON is parsed from the generated text.

## Design: screens
- **Shell:** a 76 px left rail with Create, Workflows, Activity (with a badge counting running runs) and Library. At the bottom are the engine dot and a theme switch (system / light / dark).
- **Create** (a centred column, 880 px at most):
  - **Composer card.**
    - When images are attached, a strip of numbered thumbnails appears. It supports drag-to-reorder, and each thumbnail has Mark area and Remove on hover, plus a `+` tile.
    - An auto-growing prompt box. Its placeholder switches between "Describe an image…" and "Describe the change — e.g. put image 2 on the table in image 1".
    - A bottom bar:
      - on the left: `+` add images and ✨ Improve;
      - on the right: the chips Aspect, Size, ×Count, Transparent and More, then **Generate**.
  - **Under the card:** "Saving to" with the folder chip.
  - **Suggestions** when images are attached: Remove background.
  - **Empty state:** 3 example prompts that show the capabilities (text in quotes, a transparent sticker, a 2K landscape).
  - **Results below:**
    - Cards show the live preview, a ring, `Step 12 of 28` and "In queue" while running.
    - Finished images have hover actions: Use as input, Download, Trash.
    - Clicking one opens the Lightbox: a large image, its details (prompt, seed, folder), Use as input, Edit again, Copy prompt, Download, Trash, and a Compare slider when it had one input.
- **Workflows:**
  - **List:** a card grid with the cover image, name, "5 nodes · edited 2 h ago" and a running pill. The ⋯ menu offers Open, Run, Duplicate, Copy, Rename and Delete. The page has New workflow (with 3 starters), Import, and ⌘V to paste.
  - **Editor:**
    - A top bar with Back, the inline name, "Saved", the workflow's folder chip, and **Run**, or a live progress pill while running.
    - The canvas has a dotted background, and a bottom-centre toolbar: + Image, + Generate, + Remove background.
    - Nodes are 248 px cards. The Image node shows its picture. The Generate node shows the prompt (2 lines), mini chips, the last result and live progress. The Remove background node shows its result.
    - Edges show the input number.
    - Selecting a node opens a 340 px panel with the same prompt box, input order, chips, More and folder chip as Create.
    - Keys: ⌫ delete, ⌘D duplicate, ⌘Z / ⇧⌘Z, ⌘↵ run.
  - **Run view** (`/runs/:id`): the same canvas, read-only, with a status ring on each node. The top bar shows the name, a progress bar, "3 of 5 images · Step 12 of 28", the elapsed time, and Cancel or Run again. A strip below shows the outputs. Create runs open as a simple results view.
- **Activity:** sections Running and Recent. Each row has a thumbnail stack, the name (workflow name or prompt snippet), a status and progress bar, the time, and Open, Cancel or Run again, and Remove.
- **Library:** a folder list (pinned first, with counts, and + Add folder) and an image grid of the selected folder with the Lightbox. Folders can be pinned, renamed (label only) and forgotten.
- **Folder picker:**
  - A popover with the saved folders (a check on the selected one, a pin star, the count and the path muted) and Browse Mac….
  - The Browse modal has places (Home, Desktop, Documents, Downloads, Pictures, Image Studio), a breadcrumb and a subfolder list, New folder (inline), and "Choose this folder".

**Visual system**
- Inter variable font.
- Neutral zinc greys with one violet accent (`--accent`).
- Radius 12 px; soft two-layer shadows; an 8 px spacing grid.
- 160 ms ease-out motion.
- Light and dark tokens.
- Icons from `lucide-react`.
- Images sit on a subtle checkerboard, so transparency is visible.

## Product documents this updates
`README.md` (new): setup, daily use, architecture, troubleshooting.

## Concerns flagged
- **Privacy/security (owner: Majed):**
  - The container can read and write the whole home folder. The API refuses hidden folders and `~/Library`, except its own runtime folder, and the app listens only on 127.0.0.1.
  - The model is uncensored, so there is no content filter by design.
- **Resources (owner: Majed):** with the enhancer, text encoder and generator loaded, about 45–64 GB of unified memory is in use. Idle unload frees it.
- **Upstream MPS VAE bug:** the fix is to run the VAE on the CPU, which adds about 10–20 s per 1K image. Comfy Desktop has the same bug, so its edits will look grey too until it is started with `--cpu-vae`.
- **Licence:** Qwen Research License (research, non-commercial) for the model and enhancers.

## Out of scope
- Accounts or login; access from other devices.
- Cloud models; video.
- Training or LoRAs.
- Inpainting with a brush-painted mask outside the model's own marked-area method.
- Upscaling beyond native 2K.
