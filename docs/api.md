# API reference

The web app uses a JSON API under `http://127.0.0.1:4747/api`. You can call it from scripts on the same Mac. This page lists every route. The request and response shapes match `backend/app/api.py` and the typed client in `frontend/src/lib/api.ts`.

## Conventions

- **Requests and responses are JSON,** except file uploads (multipart) and images (binary).
- **Errors** return a status code and a body of the form `{"error": "A readable message"}`.
- **Paths are absolute Mac paths,** such as `/Users/you/Pictures/Image Studio`. File routes accept paths inside your home folder and `/Volumes` only. They refuse `~/Library`, hidden folders and macOS packages.
- **Only local callers are served.** The `Host` header must be `127.0.0.1`, `localhost` or `::1`. A request that changes data and sends an `Origin` header must come from the same host and port. Tools like `curl` send no `Origin`, so they work from the Mac itself.

## Example

The following commands generate one image, wait for it, and print where it was saved:

```sh
run=$(curl -s -X POST http://127.0.0.1:4747/api/create \
	-H 'Content-Type: application/json' \
	-d '{"prompt": "A lighthouse on a cliff at dusk, oil painting", "aspect": "16:9"}' \
	| python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')

until curl -s "http://127.0.0.1:4747/api/runs/$run" \
	| python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["status"] in ("queued", "running"))'; do sleep 3; done

curl -s "http://127.0.0.1:4747/api/runs/$run" \
	| python3 -c 'import json,sys; print([o["path"] for o in json.load(sys.stdin)["outputs"]])'
```

## Status and settings

| Method | Path | Body or query | Returns |
|---|---|---|---|
| `GET` | `/api/status` | | `engine` (online, device, queue, version, error), `models` (which model files are present), `defaultFolder` |
| `GET` | `/api/settings` | | `{"defaultFolder": "..."}` |
| `PUT` | `/api/settings` | `{"defaultFolder": "/path"}` | The new setting. The folder is also added to the saved folders. |
| `GET` | `/api/options` | | The sampler and scheduler names the engine offers |

## Generation

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/create` | [Create settings](#create-settings) | `{"runId": "..."}` |
| `POST` | `/api/remove-background` | `{"asset": "<asset id>", "folder": null, "quality": "standard"}` | `{"runId": "..."}` |
| `POST` | `/api/enhance` | `{"prompt": "...", "images": ["<asset id>"]}` | `{"prompt": "...", "aspect": "16:9", "matchImage": false}` |

`/api/enhance` runs the prompt enhancer and waits for its answer, which takes about 30 to 40 seconds. It uses the image-to-image enhancer when `images` is not empty. If the caller disconnects, the enhancer stops and the route returns `409`.

### Create settings

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | required | What to make. "image 1", "img 1" and "picture 1" refer to the attached images. |
| `images` | list of asset ids | `[]` | Up to 10 input images, in order |
| `aspect` | `auto`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `16:9`, `9:16` | `auto` | `auto` follows image 1, or is 1:1 without images |
| `size` | `1k`, `2k` | `1k` | About 1 megapixel, or 2048 × 2048 at 1:1 |
| `quality` | `fast`, `standard`, `best` | `standard` | 16, 28 or 40 sampling steps |
| `count` | 1 to 4 | `1` | Number of variations |
| `transparent` | boolean | `false` | Ask for a PNG with a transparent background |
| `folder` | path or `null` | `null` | Where to save. `null` uses the default folder. |
| `advanced.seed` | integer or `null` | `null` | `null` picks a random seed |
| `advanced.negative` | string | `""` | What to avoid |
| `advanced.cfg` | 1 to 20, or `null` | `null` | Guidance. `null` means 1, or 4 when `negative` is set. |
| `advanced.steps` | 1 to 100, or `null` | `null` | Overrides `quality` |
| `advanced.sampler` | string | `euler` | One of the names from `/api/options` |
| `advanced.scheduler` | string | `simple` | One of the names from `/api/options` |
| `advanced.refDetail` | `standard`, `high`, `original` | `standard` | How much detail of the input images the model reads |

## Runs

| Method | Path | Body or query | Returns |
|---|---|---|---|
| `GET` | `/api/runs` | `limit` (1 to 500, default 60) | Run summaries, newest first |
| `GET` | `/api/runs/{id}` | | The run with its graph, node states and outputs |
| `POST` | `/api/runs/{id}/cancel` | | `204`. Stops queued and running work. |
| `POST` | `/api/runs/{id}/retry` | `{"fresh": false}` | `{"runId": "..."}` for a new run. `fresh: false` reuses finished nodes (Retry). `fresh: true` makes everything again (Run again). |
| `DELETE` | `/api/runs/{id}` | | `204`. Cancels the run if it is active and removes it from Activity. Saved images stay. |

A run's `status` is `queued`, `running`, `done`, `failed` or `canceled`.

## Workflows

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/workflows` | | Every workflow with its latest run |
| `POST` | `/api/workflows` | `{"name": null, "graph": null, "folder": null, "starter": "blank"}` | The new workflow. `starter` is `blank`, `combine` or `cutout`. |
| `GET` | `/api/workflows/{id}` | | The workflow and its graph |
| `PUT` | `/api/workflows/{id}` | `{"name": "...", "graph": {...}, "folder": "..."}` (each optional) | The saved workflow |
| `DELETE` | `/api/workflows/{id}` | | `204` |
| `POST` | `/api/workflows/{id}/duplicate` | | The copy, named like Finder does ("X copy", "X copy 2") |
| `POST` | `/api/workflows/{id}/run` | | `{"runId": "..."}` |
| `GET` | `/api/workflows/{id}/export` | | A workflow file (see below) |
| `POST` | `/api/workflows/import` | A workflow file | The new workflow |

### Graph format

A graph is `{"nodes": [...], "edges": [...]}`. Each node has an `id`, a `type`, a canvas `position` and `data`:

| Type | `data` |
|---|---|
| `image` | `{"asset": "<asset id>"}` |
| `generate` | The [Create settings](#create-settings) except `images`, plus `inputs` (the ordered ids of the connected nodes), `autoImprove` and `folder` |
| `removeBackground` | `{"folder": null, "quality": "standard"}` |
| `note` | `{"text": "...", "color": "yellow", "width": ..., "height": ...}` |

Each edge is `{"id": "...", "source": "<node id>", "target": "<node id>"}`. Running a graph that has a loop fails with `400`.

### Workflow files

An exported workflow is `{"format": "image-studio.workflow", "version": 1, "name", "graph", "folder", "assets"}`. The web app saves it as `<name>.studio.json`. `assets` maps each image node's asset id to its file path. The file holds paths, not image data, so an import re-links only the images still found at those paths.

## Images, folders and files

| Method | Path | Body or query | Returns |
|---|---|---|---|
| `POST` | `/api/assets/upload` | Multipart: one or more `files`, optional `meta` (a JSON object) | The new assets. Identical files are stored once. HEIC photos become PNG. |
| `POST` | `/api/assets/from-path` | `{"path": "/path/to/image.png"}` | The asset for an image already on disk |
| `GET` | `/api/assets/{id}` | | `id`, `name`, `path`, `url`, `thumb`, `width`, `height`, `hasAlpha` |
| `GET` | `/api/folders` | | Saved folders, pinned first, with image count and cover |
| `POST` | `/api/folders` | `{"path": "...", "pinned": false}` | The saved folder |
| `PATCH` | `/api/folders/{id}` | `{"pinned": true, "name": "..."}` | The saved folder |
| `DELETE` | `/api/folders/{id}` | | `204`. Forgets the folder. It stays on disk. |
| `GET` | `/api/folders/images` | `path`, `offset`, `limit` (default 120) | Images in the folder, newest first |
| `GET` | `/api/fs` | `path` (optional) | Subfolders, a breadcrumb, and places such as Home and Pictures |
| `POST` | `/api/fs/folder` | `{"parent": "...", "name": "..."}` | `{"path": "..."}` of the new folder |
| `GET` | `/api/file` | `path` | The image file |
| `GET` | `/api/thumb` | `path` | A WebP thumbnail |
| `GET` | `/api/files/info` | `path` | Size, dimensions, and the prompt and settings stored in the PNG |
| `POST` | `/api/files/trash` | `{"path": "..."}` | `{"id": "..."}`. Moves the image to the app trash for 30 days. |
| `POST` | `/api/files/restore` | `{"id": "..."}` | `{"path": "..."}` of the restored image |

Uploads accept PNG, JPEG, WebP, GIF, BMP, TIFF, HEIC and HEIF. Folder listings show PNG, JPEG and WebP files.

## Live events

`GET /api/events` is a [server-sent event](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream. Each message has an event name and a JSON body:

| Event | Body |
|---|---|
| `engine` | The same object as `status.engine` |
| `run` | A run summary |
| `node` | `runId`, `nodeId`, and the node's status, step, steps, progress and outputs |
| `preview` | `runId`, `nodeId`, and `image` as a JPEG data URL (at most 3 per second per node) |
| `folder` | `{"path": "..."}` of a folder whose images changed |

The server sends a comment line every 15 seconds to keep the connection open. To watch the stream from a terminal, run:

```sh
curl -N http://127.0.0.1:4747/api/events
```
