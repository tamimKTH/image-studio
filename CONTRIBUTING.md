# Contributing

Thanks for helping with Image Studio. This guide shows how to run the app from source, check your changes, and send them in.

Read [the architecture overview](docs/architecture.md) first. It explains the three parts and where each piece of code lives.

## Run the app from source

You need the engine from [Setup](docs/setup.md): run `./studio setup` once so the engine is installed and listening on `127.0.0.1:8199`. For development you run the API server and the web app yourself, next to the installed app, without Docker.

### 1. Start a development API server

```sh
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

STUDIO_APP_DIR=/tmp/image-studio-dev STUDIO_INSTANCE=dev STUDIO_IDLE_MINUTES=0 \
	.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4748 --reload
```

The three variables keep the development server apart from the installed app, which shares the same engine:

- `STUDIO_APP_DIR` gives it its own database, uploads, thumbnails and trash.
- `STUDIO_INSTANCE` gives it its own subfolders in the engine's input and output folders. Don't use `studio`, the installed app's name. Every server deletes the files in its own subfolders at startup, and a server named `studio` can also clear the engine's whole queue.
- `STUDIO_IDLE_MINUTES=0` stops it from unloading the models while the installed app uses them.

### 2. Start the web app

```sh
cd frontend
npm ci
STUDIO_API=http://127.0.0.1:4748 npm run dev
```

Open `http://localhost:5173`. Vite reloads the page when you change a file under `frontend/src`, and `--reload` restarts the API server when you change a file under `backend/app`.

Without `STUDIO_API`, the dev server sends `/api` requests to the installed app on port 4747.

### Environment variables

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `STUDIO_HOME` | your home folder | API server | The folder that file access is limited to, next to `/Volumes` |
| `STUDIO_RUNTIME_DIR` | `~/Library/Application Support/ImageStudio` | API server, `studio`, `engine/setup.sh` | The engine, its `io/` folders, and app data |
| `STUDIO_MODELS_DIR` | `~/ComfyUI-Shared/models` | API server, `studio` | Where the model files are |
| `STUDIO_ENGINE_URL` | `http://127.0.0.1:8199` | API server | The engine. Docker sets it to `http://host.docker.internal:8199`. |
| `STUDIO_APP_DIR` | `<runtime>/app` | API server | The database, uploads and thumbnails. When set, the trash moves here too. |
| `STUDIO_INSTANCE` | `studio` | API server | This server's subfolder in the engine's input and output folders |
| `STUDIO_IDLE_MINUTES` | `10` | API server | Minutes before idle models are unloaded. `0` turns it off. |
| `STUDIO_STATIC_DIR` | `/srv/static` in Docker, else `frontend/dist` | API server | The built web app to serve |
| `STUDIO_API` | `http://127.0.0.1:4747` | Vite dev server | Where `/api` requests go |

Docker Compose passes only `STUDIO_HOME`, `STUDIO_RUNTIME_DIR`, `STUDIO_ENGINE_URL` and `TZ` into the container. A custom `STUDIO_MODELS_DIR` therefore reaches the engine but not the containerized API server, whose model check and Improve still look in the default folder.

## Check your changes

The repository has no automated tests yet. Before you send a change:

1. Run `npm run build` in `frontend/`. It type-checks the code with `tsc` and builds the app into `frontend/dist`.
2. Try the change in the running app, in both the light and the dark theme.
3. If you changed the backend, generate at least one image, and run a workflow if you touched the executor.
4. If you changed behavior that the docs describe, update the docs in the same change.

## Where things go

| To change | Edit |
|---|---|
| A screen | `frontend/src/pages/` |
| The workflow canvas | `frontend/src/flow/` |
| The prompt box, image cards, lightbox or folder pickers | `frontend/src/components/` |
| Colors, spacing and themes | `frontend/src/styles/tokens.css` |
| An API route | `backend/app/api.py`, and its type in `frontend/src/lib/api.ts` |
| How runs are scheduled or saved | `backend/app/executor.py` |
| What the model receives | `backend/app/graphs.py` |
| Which paths the app may use | `backend/app/files.py` |
| Engine install or flags | `engine/setup.sh` and the `write_plist` function in `studio` |

## Send a change

1. Fork the repository and create a branch.
2. Keep each pull request to one topic.
3. Describe what changed for someone using the app, and how you checked it. Add a screenshot for UI changes.
