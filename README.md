# Image Studio

A simple local image studio for **Qwen-Image 2.1** (Uncensored Q8), running on this Mac only.
Type a prompt, drop images to edit or combine them, and build chains of generations on an n8n-style canvas.

Open **http://127.0.0.1:4747**.

## Everyday use

| Command | What it does |
|---|---|
| `./studio setup` | First install, or repair: installs the engine, prepares the models, starts everything. Safe to run again. |
| `./studio start` | Start the engine and the app |
| `./studio stop` | Stop both |
| `./studio status` | Is the engine online, and is the app running? |
| `./studio logs` | Follow the engine and app logs |
| `./studio open` | Open the app in the browser |

The engine starts again by itself at login, and Docker restarts the app when Docker Desktop starts.

## What you can do

| Place | What it is for |
|---|---|
| **Create** | One prompt box. Drop or paste images: they are numbered 1, 2, 3…, and the prompt can say "put image 2 on the table in image 1". Press **Generate** (⌘↵ or Ctrl+Enter). Each image forms live, with a step count. |
| **Workflows** | Chains on a canvas: Image → Generate → Generate → Remove background, plus sticky **Notes**. Each Generate takes up to 10 inputs, and its result feeds the next node. More below. |
| **Activity** | Every run, with live progress ("Generating image 2 of 5 · Step 12 of 28"). Runs continue in the background; open one to see each node's state. **Cancel** stops a run. **Retry** resumes a failed or canceled run, keeping the images already made. **Run again** makes a finished run's images anew. |
| **Library** | The folders images are saved to, with their images. Browse the Mac, make a new folder, and choose where new images go. **Delete** moves an image to the app's trash with Undo; it is kept 30 days. |

**On the canvas** (⌘ or Ctrl: both work on every keyboard):

- **Selecting:** drag on empty canvas to select an area. Shift-click adds a node to the selection.
- **Moving around:** Space-drag, scroll, or the middle or right mouse moves the canvas; ⌘/Ctrl + scroll zooms.
- **Copying:** ⌘/Ctrl + C copies the selection, X cuts it, V pastes it (also into another workflow), and D duplicates it.
- **Connections:** click one and press Delete to remove it. Drag its end onto another node to move it, and drag from a node's dot onto a card to connect.
- **Undo:** ⌘/Ctrl + Z undoes, ⇧⌘/Ctrl + Z redoes.
- **Workflows:** can be run, edited, duplicated, copied (⌘/Ctrl + V on the Workflows page pastes one back), exported to a `.studio.json` file, imported from a file, and deleted with Undo.

Model features in the app:

- **Text to image, up to native 2K.** Aspect ratios 1:1, 4:3, 3:4, 3:2, 2:3, 16:9 and 9:16. Size 1K (about 1 MP) or 2K (about 4 MP).
- **Edits with up to 10 reference images.** The output follows image 1 unless you pick an aspect.
- **Transparent PNGs.** Use the Transparent switch, or **Remove background** to cut out the subject.
- **Marked-area edits.** Circle or paint on an input image, or add a separate mask, then describe the change.
- **✨ Improve.** Qwen's own prompt enhancers (T2I and I2I) rewrite the prompt in detail and suggest an aspect ratio. On a workflow node, **Auto-improve** runs it with the node's actual input images.
- **More.** Quality (Fast 16 / Standard 28 / Best 40 steps), seed, negative prompt ("Avoid"), guidance, steps, sampler, scheduler and reference detail.
- **Metadata.** Every PNG stores its prompt and settings, which the Library lightbox shows.

## How it works

```
Browser ─▶ http://127.0.0.1:4747  Docker container "image-studio" (FastAPI + React, SQLite)
                                        │ HTTP + WebSocket
                                        ▼
            http://127.0.0.1:8199  native engine (launchd agent com.majed.imagestudio.engine)
                                   ComfyUI v0.37.4 + ComfyUI-GGUF, Apple GPU
```

- **Why the engine is native:** Docker on a Mac cannot reach the Apple GPU. The engine therefore runs natively as a login service, and the app runs in Docker.
- **The container sees the home folder at the same paths.** The folder browser therefore shows real Mac paths, and images are saved as normal files.
- **Engine and app data** live in `~/Library/Application Support/ImageStudio`:
  - `engine/`: ComfyUI and its Python environment
  - `io/`: the engine's working folders
  - `app/`: `studio.db`, uploads and thumbnails
  - `trash/`: deleted images, kept 30 days (Undo restores them). Docker cannot reach the macOS Trash.
  - `logs/`
- **Default save folder:** `~/Pictures/Image Studio`.
- **Models** are read from `~/ComfyUI-Shared/models`, shared with Comfy Desktop:

| File | Role |
|---|---|
| `diffusion_models/qwen-image-2.1-UC-Q8_0.gguf` | Image model |
| `text_encoders/qwen3vl_8b.dequant-bf16.safetensors` | Text/vision encoder |
| `vae/qwen_image_2.1_vae_bf16.safetensors` | VAE |
| `text_encoders/qwen3.5_9b_qwen_image_2.1_pe_{t2i,i2i}.dequant-bf16.safetensors` | Prompt enhancers |

### Two Apple-GPU workarounds (measured 2026-09-28)
- **VAE on the CPU (`--cpu-vae`).** VAE *encoding* on the Apple GPU corrupts images: a round trip has a mean error of 54/255, against 1.8 on the CPU. Edits came out grey and embossed.
- **bf16 copies of the text encoders.** The official int8 text encoders need `aten::_int_mm`, which PyTorch lacks on the Apple GPU, and on the CPU the 9B enhancer managed only about 0.4 tokens/s. `./studio setup` makes bf16 copies once with `engine/dequantize.py` (about 12 s each). On the GPU the enhancer runs at about 11 tokens/s.

Comfy Desktop has the same VAE problem: its edits look grey unless it is started with `--cpu-vae`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot at the bottom left: engine offline | `./studio start` |
| First image after a pause is slow | The models load on first use: about 40 s, then 1K Standard takes about 1.5 min |
| Memory | After 10 idle minutes the app unloads the models (about 40 GB) |
| A run shows "Interrupted by an app restart" | Press **Retry**; finished steps are reused |
| Deleted an image by mistake | Press **Undo** on the toast, or take it back from `~/Library/Application Support/ImageStudio/trash` within 30 days |

## Project

- Source: `backend/` (FastAPI), `frontend/` (React + Vite + React Flow), `engine/` (install and conversion scripts), `studio` (CLI).
- Design and decisions: `docs/changes/2026-09-28-image-studio/` (intent, spec, plan).

## Licence

Copyright (C) 2026 Majed Tamim

The code in this repository is free software under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). The full text is in [`LICENSE`](LICENSE).

Anyone may use, change and share it. If you distribute a changed version, or run one that other people use over a network, you must publish its full source under the same licence.

**The models are not covered by this licence.** The model weights and prompt enhancers are not part of this repository. They stay under the Qwen Research License (non-commercial research), and this licence gives no right to use them commercially.
