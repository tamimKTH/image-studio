# Intent: Image Studio, a local image generator with a workflow canvas
Author: Majed (owner), written by Claude from Majed's /goal request of 2026-09-28. Status: accepted (Majed asked for the build to run without pausing for questions).

## Problem
The Qwen-Image 2.1 Uncensored model now runs on this Mac, but the only way to use it is the ComfyUI graph editor. That editor exposes hundreds of technical nodes. It has no simple place to type a prompt and pick a folder on the Mac. Chaining generations (two images plus a prompt into a new image, then that result plus more images into the next one) means wiring loaders, encoders and samplers by hand. Nothing shows the progress of several runs at once.

## Proposed outcome
- **App:** a web app that runs in Docker and is opened locally in the browser.
- **Create:** type a prompt, optionally drop one or more images, press Generate, and see the image form live.
- **Saving:** every image is saved to a folder chosen on the Mac. You can browse your folders or create a new one, and the app shows the folders it saves to.
- **Workflows:** an n8n-style canvas where image nodes and generate nodes are connected into chains. Each generate node takes a prompt plus any number of input images, and its result feeds the next node. Workflows can be edited, copied, duplicated and deleted.
- **Background runs:** several workflows run at once in the background. You can come back, click any run and see how far it has got.
- **Local only:** every generation uses the local model, and every capability the model has is available: text-to-image, multi-image editing, transparent images, background removal, marked-area edits, prompt enhancement and native 2K.
- **Simplicity:** the interface is very simple, with almost no required fields, and follows strict UX simplicity principles.

## Affected users and systems
- Majed, as the only user, on this Mac (M5 Max, 128 GB).
- The model files in `~/ComfyUI-Shared/models` (shared with Comfy Desktop).
- Docker Desktop.
- A new native engine service. It is required because Docker on macOS cannot reach the Apple GPU.
- The project lives in `~/Desktop/majed/image-studio`.

## Constraints
- **Generation runs only on this Mac,** with the installed Qwen-Image 2.1 Uncensored Q8 GGUF. No cloud APIs.
- **Docker hosts the app; the model runs natively.** Docker containers on macOS have no Metal or MPS access, so the model itself must run outside the container.
- **Files the app saves are plain image files** in folders Majed chooses, so they stay visible in Finder.
- **Majed's cleanup request:** my temporary test leftovers in `~/ComfyUI-Installs/Majed-Flo` are removed.

## Open questions
None blocking. Assumptions made in place of an interview:
- A single user, with no login.
- The app is reachable only from this Mac (`127.0.0.1`).
- Saved images are PNG.
