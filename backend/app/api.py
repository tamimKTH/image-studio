"""HTTP API. Shapes match frontend/src/lib/api.ts."""
import asyncio
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import config, db, files, starters
from .engine import EngineError, engine, model_status
from .events import broker
from .executor import Canceled, GraphError, asset_json, executor

router = APIRouter(prefix="/api")

Aspect = Literal["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]
Quality = Literal["fast", "standard", "best"]
NODE_TYPES = {"image", "generate", "removeBackground", "note"}
# The lists the app offers when the engine can't be asked (it is offline).
FALLBACK_SAMPLERS = ["euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep", "uni_pc"]
FALLBACK_SCHEDULERS = ["simple", "normal", "karras", "exponential", "sgm_uniform", "beta", "linear_quadratic"]


class Advanced(BaseModel):
    seed: int | None = Field(None, ge=0, le=2**63 - 1)
    negative: str = ""
    cfg: float | None = Field(None, ge=1, le=20)
    steps: int | None = Field(None, ge=1, le=100)
    sampler: str = "euler"
    scheduler: str = "simple"
    refDetail: Literal["standard", "high", "original"] = "standard"


class GenerateSettings(BaseModel):
    aspect: Aspect = "auto"
    size: Literal["1k", "2k"] = "1k"
    quality: Quality = "standard"
    count: int = Field(1, ge=1, le=4)
    transparent: bool = False
    advanced: Advanced = Field(default_factory=Advanced)


class CreateBody(GenerateSettings):
    prompt: str
    images: list[str] = []
    folder: str | None = None


class RemoveBackgroundBody(BaseModel):
    asset: str
    folder: str | None = None
    quality: Quality = "standard"


class EnhanceBody(BaseModel):
    prompt: str
    images: list[str] = []


class PathBody(BaseModel):
    path: str


class RestoreBody(BaseModel):
    id: str


class FolderBody(BaseModel):
    path: str
    pinned: bool | None = None


class FolderPatch(BaseModel):
    pinned: bool | None = None
    name: str | None = None


class MakeDirBody(BaseModel):
    parent: str
    name: str


class SettingsBody(BaseModel):
    defaultFolder: str


class WorkflowBody(BaseModel):
    name: str | None = None
    graph: dict[str, Any] | None = None
    folder: str | None = None
    starter: Literal["blank", "combine", "cutout"] | None = None


class WorkflowPatch(BaseModel):
    name: str | None = None
    graph: dict[str, Any] | None = None
    folder: str | None = None


# ---------- helpers ----------
def default_folder() -> str:
    return db.get_setting("defaultFolder") or str(config.DEFAULT_FOLDER)


def run_folder(raw: str | None) -> str:
    return str(files.safe_dest(raw)) if raw else default_folder()


def require_asset(asset_id: str) -> dict:
    asset = db.get_asset(asset_id)
    if not asset or not Path(asset["path"]).is_file():
        raise HTTPException(404, "That image is no longer available")
    return asset


def folder_json(row: dict) -> dict:
    path = Path(row["path"])
    exists = path.is_dir()
    entries = files.image_entries(path) if exists else []
    return {"id": row["id"], "path": row["path"], "name": row["name"], "pinned": bool(row["pinned"]), "count": len(entries),
            "cover": files.thumb_url(entries[0][0]) if entries else None, "exists": exists, "lastUsedAt": row["last_used_at"]}


def check_graph(graph: dict[str, Any] | None) -> dict[str, Any]:
    graph = graph or {"nodes": [], "edges": []}
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise HTTPException(400, "A workflow needs nodes and edges")
    for n in nodes:
        if (not isinstance(n, dict) or not isinstance(n.get("id"), str) or n.get("type") not in NODE_TYPES
                or not isinstance(n.get("data") or {}, dict)):
            raise HTTPException(400, "The workflow has a step Image Studio doesn't know")
    for e in edges:
        if not isinstance(e, dict) or not isinstance(e.get("source"), str) or not isinstance(e.get("target"), str):
            raise HTTPException(400, "The workflow has a broken connection")
    return graph


def unique_name(name: str, copy: bool) -> str:
    """'X' if free (unless `copy`), else 'X copy', 'X copy 2', … like Finder."""
    name = name.strip()[:120] or "Untitled workflow"
    taken = {r["name"] for r in db.all_rows("SELECT name FROM workflows")}
    if not copy and name not in taken:
        return name
    base = re.sub(r" copy(?: \d+)?$", "", name)
    candidate, n = f"{base} copy", 2
    while candidate in taken:
        candidate, n = f"{base} copy {n}", n + 1
    return candidate


def workflow_json(row: dict) -> dict:
    return {"id": row["id"], "name": row["name"], "graph": json.loads(row["graph"]), "folder": row["folder"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def get_workflow(workflow_id: str) -> dict:
    row = db.one("SELECT * FROM workflows WHERE id = ?", (workflow_id,))
    if not row:
        raise HTTPException(404, "That workflow no longer exists")
    return row


def insert_workflow(name: str, graph: dict, folder: str | None) -> dict:
    wid, now = db.new_id(), time.time()
    db.execute("INSERT INTO workflows(id, name, graph, folder, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
               (wid, name.strip()[:120] or "Untitled workflow", json.dumps(graph), folder, now, now))
    return workflow_json(get_workflow(wid))


def get_run(run_id: str) -> dict:
    row = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not row:
        raise HTTPException(404, "That run no longer exists")
    return row


def start_run(graph: dict, **kwargs: Any) -> dict:
    try:
        return {"runId": executor.start(graph, **kwargs)}
    except GraphError as e:
        raise HTTPException(400, str(e)) from e


# ---------- status and settings ----------
@router.get("/status")
async def status() -> dict:
    return {"engine": engine.status(), "models": model_status(), "defaultFolder": default_folder()}


@router.get("/settings")
async def get_settings() -> dict:
    return {"defaultFolder": default_folder()}


@router.put("/settings")
async def put_settings(body: SettingsBody) -> dict:
    folder = files.safe_dest_dir(body.defaultFolder)
    db.set_setting("defaultFolder", str(folder))
    db.upsert_folder(str(folder), folder.name, touch=True)
    return {"defaultFolder": str(folder)}


# ---------- Mac folders ----------
@router.get("/fs")
async def list_dir(path: str | None = None) -> dict:
    return await asyncio.to_thread(files.list_dir, path, default_folder())


@router.post("/fs/folder")
async def make_dir(body: MakeDirBody) -> dict:
    return {"path": files.make_dir(body.parent, body.name)}


@router.get("/folders")
async def folders() -> list[dict]:
    rows = db.all_rows("SELECT * FROM folders ORDER BY pinned DESC, last_used_at DESC")
    return await asyncio.to_thread(lambda: [folder_json(r) for r in rows])


@router.post("/folders")
async def add_folder(body: FolderBody) -> dict:
    folder = files.safe_dest_dir(body.path)
    row = db.upsert_folder(str(folder), folder.name, pinned=body.pinned, touch=True)
    return await asyncio.to_thread(folder_json, row)


@router.patch("/folders/{folder_id}")
async def update_folder(folder_id: str, body: FolderPatch) -> dict:
    row = db.one("SELECT * FROM folders WHERE id = ?", (folder_id,))
    if not row:
        raise HTTPException(404, "That folder isn't saved")
    if body.pinned is not None:
        db.execute("UPDATE folders SET pinned = ? WHERE id = ?", (int(body.pinned), folder_id))
    if body.name is not None and body.name.strip():
        db.execute("UPDATE folders SET name = ? WHERE id = ?", (body.name.strip()[:120], folder_id))
    return await asyncio.to_thread(folder_json, db.one("SELECT * FROM folders WHERE id = ?", (folder_id,)))


@router.delete("/folders/{folder_id}", status_code=204)
async def forget_folder(folder_id: str) -> Response:
    db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    return Response(status_code=204)


@router.get("/folders/images")
async def folder_images(path: str, offset: int = 0, limit: int = 120) -> dict:
    folder = files.safe_dir(path)

    def listing() -> dict:
        entries = files.image_entries(folder)
        items = []
        for p, name, mtime in entries[max(0, offset):max(0, offset) + max(1, min(limit, 500))]:
            width, height = files.image_size(p, mtime)
            items.append({"path": p, "name": name, "mtime": mtime, "width": width, "height": height,
                          "thumb": files.thumb_url(p), "url": files.file_url(p)})
        return {"items": items, "total": len(entries)}

    return await asyncio.to_thread(listing)


# ---------- files ----------
def _image_file(path: str) -> Path:
    p = files.safe_path(path)
    if not p.is_file() or p.suffix.lower() not in config.UPLOAD_EXTENSIONS:
        raise HTTPException(404, "That image no longer exists")
    return p


@router.get("/file")
async def get_file(path: str) -> FileResponse:
    return FileResponse(_image_file(path), headers={"Cache-Control": "no-cache"})


@router.get("/thumb")
async def get_thumb(path: str) -> FileResponse:
    p = _image_file(path)
    try:
        thumb = await asyncio.to_thread(files.thumbnail, p)
    except OSError as e:
        raise HTTPException(415, "Can't make a preview of this image") from e
    return FileResponse(thumb, media_type="image/webp", headers={"Cache-Control": "no-cache"})


@router.get("/files/info")
async def file_info(path: str) -> dict:
    p = _image_file(path)
    try:
        return await asyncio.to_thread(files.file_info, p)
    except OSError as e:
        raise HTTPException(415, "Can't read this image") from e


@router.post("/files/trash")
async def trash(body: PathBody) -> dict:
    p = _image_file(body.path)
    trash_id = await asyncio.to_thread(files.move_to_trash, p)
    broker.publish("folder", {"path": str(p.parent)})
    return {"id": trash_id}


@router.post("/files/restore")
async def restore(body: RestoreBody) -> dict:
    p = await asyncio.to_thread(files.restore_from_trash, body.id)
    broker.publish("folder", {"path": str(p.parent)})
    return {"path": str(p)}


# ---------- assets ----------
@router.post("/assets/upload")
async def upload(files_: list[UploadFile] = File(..., alias="files"), meta: str | None = Form(None)) -> list[dict]:
    try:
        extra = json.loads(meta) if meta else {}
    except ValueError:
        extra = None
    if not isinstance(extra, dict):
        raise HTTPException(400, "meta must be a JSON object")
    config.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for item in files_:
        name = Path(item.filename or "image.png").name
        suffix = Path(name).suffix.lower() or ".png"
        if suffix not in config.UPLOAD_EXTENSIONS:
            raise HTTPException(400, f"“{name}” isn't a supported image")
        data = await item.read()
        digest = hashlib.sha256(data).hexdigest()
        existing = db.find_upload(digest)
        if existing and Path(existing["path"]).is_file():  # the same picture again: reuse it
            out.append(asset_json(existing))
            continue
        target = config.UPLOADS_DIR / f"{db.new_id()}{suffix}"
        target.write_bytes(data)
        try:
            target = await asyncio.to_thread(files.convert_upload, target)
            width, height, alpha = await asyncio.to_thread(files.open_image, target)
        except Exception as e:
            target.unlink(missing_ok=True)
            raise HTTPException(400, f"Image Studio can't read “{name}”") from e
        out.append(asset_json(db.insert_asset(str(target), "upload", width, height, alpha, {**extra, "name": name, "sha256": digest})))
    return out


@router.post("/assets/from-path")
async def asset_from_path(body: PathBody) -> dict:
    p = _image_file(body.path)
    existing = db.one("SELECT id FROM assets WHERE path = ? ORDER BY created_at DESC LIMIT 1", (str(p),))
    if existing:
        return asset_json(db.get_asset(existing["id"]))  # type: ignore[arg-type]
    try:
        width, height, alpha = await asyncio.to_thread(files.open_image, p)
    except Exception as e:
        raise HTTPException(400, f"Image Studio can't read “{p.name}”") from e
    return asset_json(db.insert_asset(str(p), "file", width, height, alpha))


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str) -> dict:
    return asset_json(require_asset(asset_id))


# ---------- generation ----------
@router.post("/create")
async def create(body: CreateBody) -> dict:
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(400, "Write a prompt first")
    if len(body.images) > config.MAX_INPUTS:
        raise HTTPException(400, f"Use at most {config.MAX_INPUTS} images")
    inputs = [f"in{i}" for i in range(1, len(body.images) + 1)]
    nodes: list[dict[str, Any]] = [{"id": nid, "type": "image", "position": {"x": 0, "y": i * 160}, "data": {"asset": require_asset(a)["id"]}}
                                   for i, (nid, a) in enumerate(zip(inputs, body.images))]
    data = body.model_dump(exclude={"prompt", "images", "folder"})
    nodes.append({"id": "gen", "type": "generate", "position": {"x": 340, "y": 0},
                  "data": {**data, "prompt": prompt, "inputs": inputs, "autoImprove": False, "folder": None}})
    graph = {"nodes": nodes, "edges": [{"id": f"e-{nid}", "source": nid, "target": "gen"} for nid in inputs]}
    return start_run(graph, kind="create", name=prompt.splitlines()[0][:80], folder=run_folder(body.folder))


@router.post("/remove-background")
async def remove_background(body: RemoveBackgroundBody) -> dict:
    asset = require_asset(body.asset)
    graph = {"nodes": [{"id": "in1", "type": "image", "position": {"x": 0, "y": 0}, "data": {"asset": asset["id"]}},
                       {"id": "cut", "type": "removeBackground", "position": {"x": 340, "y": 0},
                        "data": {"folder": None, "quality": body.quality}}],
             "edges": [{"id": "e-in1", "source": "in1", "target": "cut"}]}
    return start_run(graph, kind="create", name=f"Remove background · {asset_json(asset)['name']}", folder=run_folder(body.folder))


@router.get("/options")
async def options() -> dict:
    """The sampler and scheduler names the engine offers (its KSampler inputs)."""
    try:
        samplers, schedulers = await engine.samplers()
    except EngineError:
        samplers, schedulers = FALLBACK_SAMPLERS, FALLBACK_SCHEDULERS
    return {"samplers": samplers, "schedulers": schedulers}


@router.post("/enhance")
async def enhance(body: EnhanceBody, request: Request) -> dict:
    if not body.prompt.strip():
        raise HTTPException(400, "Write a prompt first")
    paths = [Path(require_asset(a)["path"]) for a in body.images[: config.MAX_INPUTS]]
    try:
        prompt, aspect, match = await executor.enhance(body.prompt, paths, disconnected=request.is_disconnected)
    except Canceled as e:
        raise HTTPException(409, "Stopped") from e
    return {"prompt": prompt, "aspect": aspect, "matchImage": match}


# ---------- workflows ----------
@router.get("/workflows")
async def workflows() -> list[dict]:
    out = []
    for row in db.all_rows("SELECT * FROM workflows ORDER BY updated_at DESC"):
        graph = json.loads(row["graph"])
        last = db.one("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1", (row["id"],))
        cover = None
        if last:
            summary = executor.summary(last)
            cover = summary["thumbs"][0] if summary["thumbs"] else None
        if not cover:
            for node in graph.get("nodes", []):
                asset = db.get_asset((node.get("data") or {}).get("asset") or "") if node.get("type") == "image" else None
                if asset and Path(asset["path"]).is_file():
                    cover = files.thumb_url(asset["path"])
                    break
        out.append({"id": row["id"], "name": row["name"], "updatedAt": row["updated_at"], "nodeCount": len(graph.get("nodes", [])),
                    "cover": cover, "lastRun": {"id": last["id"], "status": last["status"], "total": last["total"], "done": last["done"]} if last else None})
    return out


@router.post("/workflows")
async def create_workflow(body: WorkflowBody) -> dict:
    if body.graph is not None:
        name, graph = body.name or "Untitled workflow", check_graph(body.graph)
    else:
        starter_name, graph = starters.build(body.starter or "blank")
        name = body.name or starter_name
    return insert_workflow(name, graph, body.folder)


@router.get("/workflows/{workflow_id}")
async def read_workflow(workflow_id: str) -> dict:
    return workflow_json(get_workflow(workflow_id))


@router.put("/workflows/{workflow_id}")
async def save_workflow(workflow_id: str, body: WorkflowPatch) -> dict:
    get_workflow(workflow_id)
    fields = body.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"] is not None:
        db.execute("UPDATE workflows SET name = ? WHERE id = ?", (fields["name"].strip()[:120] or "Untitled workflow", workflow_id))
    if "graph" in fields and fields["graph"] is not None:
        db.execute("UPDATE workflows SET graph = ? WHERE id = ?", (json.dumps(check_graph(fields["graph"])), workflow_id))
    if "folder" in fields:
        db.execute("UPDATE workflows SET folder = ? WHERE id = ?", (fields["folder"], workflow_id))
    db.execute("UPDATE workflows SET updated_at = ? WHERE id = ?", (time.time(), workflow_id))
    return workflow_json(get_workflow(workflow_id))


@router.delete("/workflows/{workflow_id}", status_code=204)
async def delete_workflow(workflow_id: str) -> Response:
    db.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
    return Response(status_code=204)


@router.post("/workflows/{workflow_id}/duplicate")
async def duplicate_workflow(workflow_id: str) -> dict:
    row = get_workflow(workflow_id)
    return insert_workflow(unique_name(row["name"], copy=True), json.loads(row["graph"]), row["folder"])


@router.get("/workflows/{workflow_id}/export")
async def export_workflow(workflow_id: str) -> dict:
    row = get_workflow(workflow_id)
    graph = json.loads(row["graph"])
    assets = {}
    for node in graph.get("nodes", []):
        asset = db.get_asset((node.get("data") or {}).get("asset") or "") if node.get("type") == "image" else None
        if asset:
            assets[asset["id"]] = asset["path"]
    return {"format": "image-studio.workflow", "version": 1, "name": row["name"], "graph": graph, "folder": row["folder"], "assets": assets}


@router.post("/workflows/import")
async def import_workflow(body: dict[str, Any]) -> dict:
    if body.get("format") != "image-studio.workflow" or not isinstance(body.get("graph"), dict):
        raise HTTPException(400, "That isn't an Image Studio workflow")
    graph = check_graph(body["graph"])
    paths = body.get("assets") if isinstance(body.get("assets"), dict) else {}
    for node in graph["nodes"]:
        data = node.get("data") or {}
        if node.get("type") != "image" or not data.get("asset"):
            continue
        asset = db.get_asset(data["asset"])
        if asset and Path(asset["path"]).is_file():
            continue
        path = paths.get(data["asset"])
        try:
            data["asset"] = (await asset_from_path(PathBody(path=path)))["id"] if isinstance(path, str) and path else None
        except HTTPException:
            data["asset"] = None
    folder = body.get("folder") if isinstance(body.get("folder"), str) else None
    return insert_workflow(unique_name(str(body.get("name") or "Imported workflow"), copy=False), graph, folder)


@router.post("/workflows/{workflow_id}/run")
async def run_workflow(workflow_id: str) -> dict:
    row = get_workflow(workflow_id)
    return start_run(json.loads(row["graph"]), kind="workflow", name=row["name"], folder=run_folder(row["folder"]),
                     workflow_id=workflow_id)


# ---------- runs ----------
@router.get("/runs")
async def runs(limit: int = 60) -> list[dict]:
    rows = db.all_rows("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),))
    return [executor.summary(r) for r in rows]


@router.get("/runs/{run_id}")
async def run_detail(run_id: str) -> dict:
    return executor.detail(get_run(run_id))


@router.post("/runs/{run_id}/cancel", status_code=204)
async def cancel_run(run_id: str) -> Response:
    get_run(run_id)
    await executor.cancel(run_id)
    return Response(status_code=204)


@router.post("/runs/{run_id}/retry")
async def retry_run(run_id: str) -> dict:
    get_run(run_id)
    try:
        return {"runId": executor.retry(run_id)}
    except GraphError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/runs/{run_id}", status_code=204)
async def delete_run(run_id: str) -> Response:
    if get_run(run_id)["status"] in ("queued", "running"):
        await executor.cancel(run_id)
    db.execute("DELETE FROM run_nodes WHERE run_id = ?", (run_id,))
    db.execute("DELETE FROM runs WHERE id = ?", (run_id,))
    return Response(status_code=204)


# ---------- live events ----------
@router.get("/events")
async def events() -> StreamingResponse:
    return StreamingResponse(broker.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
