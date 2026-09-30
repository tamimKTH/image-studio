---
name: image-studio
description: Use when installing, setting up, starting, stopping, updating, uninstalling or troubleshooting Image Studio, the local Qwen-Image 2.1 app for Apple silicon Macs (ComfyUI engine on port 8199, Docker app on port 4747, the ./studio command); when generating images or running workflows through its HTTP API; when running it from source or checking a change; or when answering questions about what the product does and how it works.
---

# Image Studio

Image Studio is a local web app for the Qwen-Image 2.1 model on an Apple silicon Mac. It makes images from a prompt, edits and combines up to 10 input images, makes transparent PNGs and cutouts, and chains steps on a node canvas. Nothing leaves the Mac.

It has three parts:

- **Web app** (React) and **API server** (FastAPI + SQLite) run in one Docker container at `http://127.0.0.1:4747`.
- **Engine** (ComfyUI + GGUF) runs natively as the launchd agent `com.majed.imagestudio.engine` at `http://127.0.0.1:8199`, because Docker on macOS can't reach the Apple GPU.
- **`./studio`** in the repository root installs, starts and stops both.

Run every command from the repository root, the folder that holds `./studio`. If your shell doesn't keep the working folder between commands, start each command with `cd <repository root> &&`. For commands, paths and numbers, the docs are the source of truth. If this skill disagrees with them on those, follow the docs and fix this skill. The rules for agents in this skill still apply, for example reading logs with `tail` instead of `./studio logs`.

| To find | Read |
|---|---|
| Requirements, model downloads, install, update, uninstall, troubleshooting | `docs/setup.md` |
| Every screen, setting and keyboard shortcut | `docs/product.md` |
| How a run works, data folders, security model, code map | `docs/architecture.md` |
| Every HTTP route, live event and the workflow graph format | `docs/api.md` |
| Running from source, environment variables, where code lives | `CONTRIBUTING.md` |

## Current state

```sh
./studio status                            # engine online/offline, app running/not running
curl -s http://127.0.0.1:4747/api/status   # when the app runs: engine state and which model files it found
```

| `./studio status` shows | Do this |
|---|---|
| engine online, app running | It is installed and running. Don't run `setup`. |
| engine online, app not running | Check that Docker Desktop runs (`docker info`), then `./studio start`. |
| engine offline, and `~/Library/LaunchAgents/com.majed.imagestudio.engine.plist` exists | `./studio start`. If the engine doesn't come up, `./studio setup` repairs it. |
| engine offline, no plist | Not installed. Follow **Install**. |

## Install

Aim for a user who answers one question and then waits. Do the checks yourself, ask once, then run every step to the end. Ask again only if a step fails in a way this skill doesn't cover.

### 1. Get the code

If the current folder has no `./studio` file, clone the repository into the folder the user named, or into `~/image-studio`:

```sh
git clone https://github.com/tamimKTH/image-studio.git ~/image-studio
```

If that folder already holds a clone, run `git pull` in it instead. Run every later command from the clone.

### 2. Check the Mac

```sh
bash .agents/skills/image-studio/scripts/prepare.sh check
```

The script changes nothing. It reports the chip, memory, free disk, git, uv and Docker, each model file, what is already installed, and the download and disk space still needed. Act on its report:

| Report says | Do this |
|---|---|
| `app running` | It is already installed. Give the user the address and stop. |
| `engine installed`, and no model is missing | It is installed but stopped. Run `./studio start`, then go to step 6. |
| `chip ... NOT SUPPORTED` | Stop. Tell the user that Image Studio needs an Apple silicon Mac. |
| `memory ... BELOW` | Mention it in the question in step 3. |
| `uv MISSING` | Install it yourself after the user says yes: `brew install uv`, or the `curl` command the report prints when Homebrew is missing. |
| `git MISSING` | The user runs `xcode-select --install` and clicks through the dialog. |
| `Docker MISSING` | The user installs Docker Desktop, opens it once, and accepts its terms. You can't do this for them. |
| `Docker ... NOT RUNNING` | Run `open -a Docker` yourself, then repeat `docker info` every 10 seconds for up to 3 minutes. |
| `BLOCKER not enough free disk space` | Stop. Tell the user how many GB to free. |
| `engine not installed` together with `engine online` | Another program, often another ComfyUI, uses port 8199. Ask the user to stop it before you continue. |

### 3. Ask once

Send one message with these parts, in this order:

1. What the check found: "This Mac meets the requirements", or one line for each problem and who fixes it.
2. The plan:
   - download the missing model files (the report's GB) to `~/ComfyUI-Shared/models`;
   - install the engine into `~/Library/Application Support/ImageStudio` as a login service;
   - convert three text encoders into bf16 copies (up to 55 GB);
   - build and start the app in Docker, with your home folder mounted so it can save images where you choose;
   - make one test image in `~/Pictures/Image Studio`.
3. The disk space: the report's "about N GB needed" and the GB free.
4. The license: the model weights are under the Qwen Research License, which allows non-commercial research use only (https://huggingface.co/Qwen/Qwen-Image-2.1). The model is uncensored, and the app adds no content filter.
5. The time: the download takes about 50 minutes for 37 GB at 100 Mbit/s, and `setup` takes a while longer.
6. If your shell tool runs commands in a sandbox: these commands need network access and write outside the project folder, so ask the user to allow that.
7. The question: "Shall I go ahead?"

After a yes, don't ask again for any step in this plan.

### 4. Download the models

Skip this step when the report says `download 0 GB`. The Hugging Face repositories are public, so no login is needed. Start the download in the background, so it survives the command timeout of your shell tool:

```sh
nohup bash .agents/skills/image-studio/scripts/prepare.sh download > /tmp/image-studio-download.log 2>&1 &
```

Check on it every minute or two, and tell the user the progress now and then:

```sh
tail -n 3 /tmp/image-studio-download.log; du -sh ~/ComfyUI-Shared/models; pgrep -f "prepare[.]sh download" >/dev/null && echo running
```

- The download is done when the log ends with `Download finished.`
- If the log ends with `Download failed.`, run the `nohup` command again. It downloads only the files that are still missing.
- If `running` no longer prints and the log has no final line, your tool stopped the background process. Run the download in the foreground with the longest timeout your tool allows, as often as it takes.

### 5. Install and start

Check that `docker info` succeeds, then start `setup` in the background:

```sh
nohup bash -c './studio setup; echo "setup exited with $?"' > /tmp/image-studio-setup.log 2>&1 &
```

Check on it every minute or two:

```sh
tail -n 5 /tmp/image-studio-setup.log; pgrep -f "studio[ ]setup" >/dev/null && echo running
```

- `setup` installs the engine (about 1.5 GB), converts the three text encoders, writes the login service, starts the engine, and builds and starts the Docker app.
- The log stays quiet for long stretches. To see progress, run `du -sh ~/Library/Application\ Support/ImageStudio/engine ~/ComfyUI-Shared/models/text_encoders`.
- It is done when the log ends with `Image Studio is running: http://127.0.0.1:4747` and `setup exited with 0`.
- With another exit code, read the log, fix the cause with **Troubleshooting**, and run the same command again. `setup` is safe to repeat.
- If `running` no longer prints and the log has no `setup exited` line, your tool stopped the background process. Run `./studio setup` in the foreground with the longest timeout it allows, and repeat it until it finishes.

### 6. Prove it works

```sh
./studio status
curl -s http://127.0.0.1:4747/api/status
```

- `./studio status` must show `engine: online` and `app: running`.
- In `/api/status`, all five entries under `models` must be `true`: `generator`, `textEncoder`, `vae`, `enhancerT2I` and `enhancerI2I`. The two enhancers power the Improve button, and the app makes images without them. If one is `false`, check `tail -n 50 /tmp/image-studio-setup.log` for a failed conversion, delete any `*.part` file in `~/ComfyUI-Shared/models/text_encoders`, and run step 5 again.
- Make one test image with the commands in **Generate from the terminal**, with `"quality": "fast"` and `"count": 1`. The first image also loads the models, so allow about 2 minutes. It must end with status `done` and print a file path.

### 7. Hand over

1. Open the app with `open http://127.0.0.1:4747`.
2. Tell the user:
   - the address, `http://127.0.0.1:4747`;
   - where the test image is;
   - that `./studio start`, `./studio stop` and `./studio status` run from the clone folder;
   - that the engine starts by itself at login.
3. Offer to free 28 GB by deleting the three `*int8_convrot.safetensors` files in `~/ComfyUI-Shared/models/text_encoders`. Delete them only after the user says yes, and only after you confirm that all three `*.dequant-bf16.safetensors` copies exist.

## Everyday commands

| Command | Does |
|---|---|
| `./studio start` | Starts the engine and rebuilds and starts the app. Waits up to 2 minutes for each. |
| `./studio stop` | Stops both |
| `./studio status` | One line each for engine and app |
| `./studio setup` | First install or repair. Safe to repeat. |
| `./studio logs` | Follows both logs and **never exits**. In an agent, read the logs with the commands below instead. |
| `./studio open` | Opens the app in the browser |

```sh
tail -n 100 ~/Library/Application\ Support/ImageStudio/logs/engine.log   # the engine
docker compose logs --tail 100                                          # the app, run from the repository root
```

## Rules

- **Start and stop through `./studio`.** A plain `docker compose up` starts the app without the engine, and it skips writing the `.env` file that Compose reads.
- **Check for running work before `start`, `setup` or `stop`.** A restart ends active runs with "Interrupted by an app restart". Ask the user first if this command lists any run ids:

  ```sh
  curl -sf 'http://127.0.0.1:4747/api/runs?limit=500' | python3 -c 'import json,sys; d=sys.stdin.read(); print([r["id"] for r in json.loads(d) if r["status"] in ("queued","running")] if d else "The app is not running, so no work is active.")'
  ```

  `setup` and `stop` also restart the shared engine, which ends a development server's runs too. If one runs on port 4748, check it the same way.
- **`start` and `setup` build the app image from the working tree.** Uncommitted edits in `backend/` or `frontend/` go into the installed app. To try unfinished work, use **Run from source** instead.
- **Ask before anything destructive:** the uninstall commands, deleting `~/Library/Application Support/ImageStudio/engine`, or deleting model files.
- **Keep the int8 text encoders until their `*.dequant-bf16.safetensors` copies exist.** `setup` can only rebuild a missing bf16 copy from its int8 file.
- **The app answers only on `127.0.0.1`, `localhost` or `::1`.** Other host names get a page that says so.

## Update after `git pull`

1. Check for running work, and for uncommitted edits with `git status --short -- backend frontend` (see **Rules**).
2. Find the commit from before the pull. Run `git reflog show -3 "$(git branch --show-current)"`. If the newest entry is the pull, the old commit is `@{1}`, for a merge pull and a rebase pull alike. Otherwise, ask the user.
3. See what changed: `git diff --stat @{1} HEAD -- studio engine/`.
4. Pick the command:
   - If only app code changed, run `./studio start`. It rebuilds the app image, dependencies included.
   - If `studio` changed, run `./studio setup`. Only `setup` rewrites the login service that holds the engine flags.
   - If `engine/setup.sh` changed, `setup` won't replace the existing engine. With the user's approval, run `./studio stop`, delete `~/Library/Application Support/ImageStudio/engine`, then run `./studio setup`.
5. Confirm with `./studio status`.

## Generate from the terminal

The API needs the app running. If `./studio status` says `app: not running`, run `./studio start` first. `curl` works because it sends no `Origin` header.

```sh
run=$(curl -s -X POST http://127.0.0.1:4747/api/create -H 'Content-Type: application/json' \
  -d '{"prompt": "A lighthouse on a cliff at dusk", "aspect": "16:9", "count": 2, "transparent": true}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
echo "run $run"
for i in $(seq 600); do   # waits up to 30 minutes
  curl -s "http://127.0.0.1:4747/api/runs/$run" \
    | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["status"] in ("queued","running"))' && break
  sleep 3
done
curl -s "http://127.0.0.1:4747/api/runs/$run" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["status"], r["error"] or ""); print(*[o["path"] for o in r["outputs"]], sep="\n")'
```

- If the wait outlasts your tool's timeout, run the loop again with the run id it printed.
- The last command prints the run's status (`done`, `failed` or `canceled`), the error if there is one, and the saved file paths.
- A 1K image at Standard quality takes about 85 to 100 seconds on an M5 Max, plus about 20 seconds when the models have to load.
- Images save to `~/Pictures/Image Studio` unless the body sets `folder` to an absolute path.
- `transparent` defaults to `false` in the API. Set it to `true` for a PNG with a transparent background. When it is `false`, transparent inputs are flattened onto white.

To edit or combine images, turn each file into an asset id, then pass the ids in order as `images`:

```sh
asset() { curl -s -X POST http://127.0.0.1:4747/api/assets/from-path -H 'Content-Type: application/json' \
  -d "{\"path\": \"$1\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
room=$(asset "$HOME/Pictures/room.jpg"); cat=$(asset "$HOME/Pictures/cat.png")
curl -s -X POST http://127.0.0.1:4747/api/create -H 'Content-Type: application/json' \
  -d "{\"prompt\": \"Put the cat from image 2 on the sofa in image 1\", \"images\": [\"$room\", \"$cat\"]}"
```

- Image 1 is the picture being edited, and the result takes its shape. Put the scene first and the things to add after it.
- The prompt refers to inputs by position: "image 2", "img 2" and "picture 2" all work.
- `from-path` takes an absolute path inside the home folder or `/Volumes`, and returns one asset. `POST /api/assets/upload` takes multipart `files` and returns a list of assets.
- Other fields (`size`, `quality`, `advanced.*`) and the workflow routes are in `docs/api.md`.

## Run from source

This runs your working tree next to the installed app, without Docker. The engine must be installed and online (`./studio status`). The development API server shares that engine, so the variables below keep it apart from the installed app.

1. Install the dependencies. Skip a line when its folder (`backend/.venv` or `frontend/node_modules`) already exists, unless `backend/requirements.txt` or `frontend/package-lock.json` changed since it was made.

   ```sh
   (cd backend && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt)
   (cd frontend && npm ci)
   ```

2. Start the API server on port 4748. It keeps running, so start it in the background.

   ```sh
   (cd backend && STUDIO_APP_DIR=/tmp/image-studio-dev STUDIO_INSTANCE=dev STUDIO_IDLE_MINUTES=0 \
     .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4748 --reload)
   ```

3. Start the web app in a second background process, then open `http://localhost:5173`.

   ```sh
   (cd frontend && STUDIO_API=http://127.0.0.1:4748 npm run dev)
   ```

- Never set `STUDIO_INSTANCE=studio`. Every server deletes the files in its own engine subfolders at startup, and a server named `studio` can also clear the engine's queue.
- `--reload` restarts the API server when a file in `backend/app` changes, and Vite reloads the page when a file in `frontend/src` changes.
- Without `STUDIO_API`, the Vite server sends `/api` to the installed app on port 4747. When the installed app is down, the page then shows a red status dot.
- To call the development server's API, use port 4748 in the commands under **Generate from the terminal**.
- The development server saves images to the same default folder, `~/Pictures/Image Studio`, unless a request or the web app picks another folder.
- To stop the servers, stop the two background processes you started.

## Check a change

- The repo has no automated tests or linter. Don't look for a test command.
- For a frontend change, run `npm run build` in `frontend/`. It type-checks with `tsc`, then builds.
- For a backend change, generate at least one image against the development server on port 4748.
- If you changed `backend/app/executor.py`, also run a workflow in the development web app at `http://localhost:5173`, with at least one image node connected to a Generate node.
- For a UI change, check both the light and the dark theme.
- If the change alters behavior that the docs describe, update the docs in the same change.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot at the bottom of the left rail | Run `./studio status`. If something is offline, run `./studio start`, after the checks in **Rules**. Clicking the dot shows which part is offline and which model files are missing. |
| `uv is required` | `brew install uv` |
| `Docker Desktop is required`, or `docker` errors | Install or start Docker Desktop |
| `Apple GPU (MPS) not available` | The Mac is not Apple silicon. The app can't run on it. |
| `Missing .../qwen-image-2.1-UC-Q8_0.gguf` | Download the models (Install, step 4) |
| `The engine did not start` | Read the last 100 lines of `engine.log` (see **Everyday commands**) |
| A run says "Interrupted by an app restart" | Press **Retry**, or `POST /api/runs/{id}/retry`. Finished steps are reused. |
| First image after a break is slow | Expected. Models unload after 10 idle minutes and take about 20 seconds to load. |

The full table is in `docs/setup.md`, section "Troubleshooting".
