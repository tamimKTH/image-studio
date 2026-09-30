# Image Studio

Image Studio is a local web app for Qwen-Image 2.1 on Apple silicon Macs. The React web app and the FastAPI server run in Docker at `http://127.0.0.1:4747`. The ComfyUI engine runs natively as a launchd agent at `http://127.0.0.1:8199`, because Docker on macOS can't reach the Apple GPU.

## Read the skill first

Before you install, start, stop, update or troubleshoot the app, call its API, or run it from source, read `.agents/skills/image-studio/SKILL.md`. Agents with skill support load it as the `image-studio` skill.

## Rules for every task

- Start and stop the app only through `./studio`. Don't run `./studio logs` from an agent, because it never exits. The skill shows how to read the logs.
- `./studio start` and `./studio setup` build the app image from the working tree, so they put uncommitted edits into the installed app. To try unfinished code, run it from source as the skill describes, with the API server on port 4748 and the web app on port 5173.
- A restart ends active runs. Check for queued or running work before `start`, `setup` or `stop`.
- Ask the user before you download the models (about 37 GB, non-commercial license) and before you delete anything in `~/Library/Application Support/ImageStudio` or `~/ComfyUI-Shared/models`.
- The repository has no automated tests. After a frontend change, run `npm run build` in `frontend/`. After a backend change, generate an image against a development server.
- When a change alters behavior that the docs describe, update `docs/` in the same change.

## Where to look

| For | Read |
|---|---|
| Where code lives | `docs/architecture.md` (Code map) and `CONTRIBUTING.md` (Where things go) |
| HTTP routes and events | `docs/api.md`, with the types in `frontend/src/lib/api.ts` |
| What each screen and setting does | `docs/product.md` |
| Install, update and troubleshooting | `docs/setup.md` |
