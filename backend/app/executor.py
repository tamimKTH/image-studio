"""Runs a graph of image / generate / removeBackground nodes on the engine, in the background.

Every run (a Create or a workflow) is a DAG. A node is submitted when all its inputs are done; each
variation is one engine prompt. The engine works first-in-first-out, so runs interleave. Progress,
previews and results are written to SQLite and published as server-sent events.
"""
import asyncio
import base64
import json
import logging
import random
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import config, db, files
from .engine import EngineError, EngineOffline, engine, model_status
from .events import broker
from .graphs import (ENHANCER_OUTPUT_NODE, QUALITY_STEPS, REMOVE_BACKGROUND_PROMPT, Sampling, enhancer_graph,
                     image_graph, nearest_aspect, normalize_references, parse_enhancer, reference_resolution,
                     wrap_transparent)

log = logging.getLogger("studio.executor")

ACTIVE = ("queued", "running")
ENDED = ("failed", "skipped", "canceled")
RESTART_MESSAGE = "Interrupted by an app restart"
PREVIEW_INTERVAL = 1 / 3  # at most 3 previews per second per node


class GraphError(ValueError):
    """The graph can't run as it is; the message is shown to the user."""


class Canceled(Exception):
    pass


@dataclass
class Job:
    """One prompt in the engine: one image variation, or one prompt-improver call."""
    kind: str  # "image" | "enhance"
    run_id: str | None
    node_id: str | None
    seed: int = 0
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    prompt_id: str = ""
    started: bool = False
    step: int = 0
    steps: int = 0
    images: list[dict] = field(default_factory=list)
    text: list[str] | None = None
    error: str | None = None
    canceled: bool = False


# ---------- graph helpers ----------
def node_units(node: dict) -> int:
    if node["type"] == "generate":
        return max(1, min(4, int((node.get("data") or {}).get("count") or 1)))
    return 1 if node["type"] == "removeBackground" else 0


def ordered_inputs(node: dict, edges: list[dict]) -> list[str]:
    """Sources in the node's chosen order (`data.inputs`), then any other connected source in edge order."""
    sources: list[str] = []
    for e in edges:
        if e["target"] == node["id"] and e["source"] not in sources:
            sources.append(e["source"])
    preferred = [s for s in (node.get("data") or {}).get("inputs") or [] if s in sources]
    return preferred + [s for s in sources if s not in preferred]


def parse_graph(graph: dict) -> tuple[dict[str, dict], list[dict]]:
    """The nodes that run and the connections between them. Sticky notes never run and connect to nothing."""
    nodes = {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and n.get("id") and n.get("type") != "note"}
    edges = [e for e in graph.get("edges", []) if isinstance(e, dict) and e.get("source") in nodes and e.get("target") in nodes]
    return nodes, edges


def save_folder(raw: str) -> Path:
    """A node's or run's save folder, checked like every other folder the app writes to."""
    try:
        return files.safe_dest(raw)
    except HTTPException as e:
        raise GraphError("That save folder isn't allowed") from e


def validate(graph: dict) -> tuple[dict[str, dict], list[dict]]:
    nodes, edges = parse_graph(graph)
    if not any(n.get("type") in ("generate", "removeBackground") for n in nodes.values()):
        raise GraphError("Add a Generate or Remove background node")
    for node in nodes.values():
        kind, data = node.get("type"), node.get("data") or {}
        inputs = ordered_inputs(node, edges)
        if data.get("folder"):
            save_folder(str(data["folder"]))
        if kind == "image":
            asset = db.get_asset(data.get("asset") or "")
            if not asset:
                raise GraphError("Choose a picture for every Image node")
            if not Path(asset["path"]).is_file():
                raise GraphError(f"The picture “{Path(asset['path']).name}” no longer exists")
        elif kind == "generate":
            if not str(data.get("prompt") or "").strip():
                raise GraphError("Add a prompt to every Generate node")
            if len(inputs) > config.MAX_INPUTS:
                raise GraphError(f"A Generate node takes at most {config.MAX_INPUTS} images")
        elif kind == "removeBackground":
            if len(inputs) != 1:
                raise GraphError("Connect exactly one image to Remove background")
        else:
            raise GraphError(f"Unknown node type: {kind}")
    # Kahn's algorithm: every node must be reachable in topological order, or there is a cycle.
    indegree = {nid: 0 for nid in nodes}
    for e in edges:
        indegree[e["target"]] += 1
    ready = [nid for nid, d in indegree.items() if d == 0]
    seen = 0
    while ready:
        nid = ready.pop()
        seen += 1
        for e in edges:
            if e["source"] == nid:
                indegree[e["target"]] -= 1
                if indegree[e["target"]] == 0:
                    ready.append(e["target"])
    if seen != len(nodes):
        raise GraphError("The workflow has a loop; connections must flow one way")
    return nodes, edges


def slug(text: str, limit: int = 40) -> str:
    # Drop accent marks ("café" → "cafe") but keep letters of every script (Arabic, Chinese, …).
    plain = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", "-", plain.lower())[:limit].strip("-") or "image"


# ---------- JSON shapes (see frontend/src/lib/api.ts) ----------
def asset_name(a: dict) -> str:
    """The name the user knows: the uploaded file's original name, else the file's own name."""
    return (a.get("meta") or {}).get("name") or Path(a["path"]).name


def asset_json(a: dict) -> dict:
    return {"id": a["id"], "name": asset_name(a), "path": a["path"], "url": files.file_url(a["path"]),
            "thumb": files.thumb_url(a["path"]), "width": a["width"] or 0, "height": a["height"] or 0,
            "hasAlpha": bool(a["has_alpha"])}


def output_json(a: dict) -> dict:
    return {"id": a["id"], "url": files.file_url(a["path"]), "thumb": files.thumb_url(a["path"]), "path": a["path"],
            "name": asset_name(a)}


def _outputs(ids: list[str], assets: dict[str, dict]) -> list[dict]:
    return [output_json(assets[i]) for i in ids if i in assets and Path(assets[i]["path"]).is_file()]


class Executor:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}  # engine prompt id → job
        self.canceled: set[str] = set()
        self.units: dict[tuple[str, str], list[int]] = {}  # (run, node) → [finished, total] variations
        self._last_preview: dict[tuple[str, str], float] = {}
        self._tasks: set[asyncio.Task] = set()
        self.last_activity = time.time()
        self.unloaded = False
        self._orphans = False  # the previous app run left work in the engine

    # ---------- startup ----------
    def recover(self) -> None:
        """Runs that were active when the app stopped can't be resumed in place; they are marked failed (Run again resumes)."""
        now = time.time()
        for row in db.all_rows("SELECT id FROM runs WHERE status IN ('queued', 'running')"):
            # Clearing the engine queue would also drop other backends' work; only the main app does it.
            self._orphans = config.INSTANCE == "studio"
            db.execute("UPDATE run_nodes SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
                       (RESTART_MESSAGE, now, row["id"]))
            db.execute("UPDATE run_nodes SET status = 'skipped' WHERE run_id = ? AND status = 'waiting'", (row["id"],))
            db.execute("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", (RESTART_MESSAGE, now, row["id"]))
        for folder in (config.ENGINE_INPUT_DIR / config.INSTANCE, config.ENGINE_OUTPUT_DIR / config.INSTANCE):
            for leftover in folder.glob("*"):
                if leftover.is_file():
                    leftover.unlink(missing_ok=True)

    # ---------- summaries ----------
    def summary(self, run: dict, rows: list[dict] | None = None) -> dict:
        rows = rows if rows is not None else db.all_rows("SELECT * FROM run_nodes WHERE run_id = ?", (run["id"],))
        nodes, _ = parse_graph(json.loads(run["graph"]))
        work = [r for r in rows if nodes.get(r["node_id"], {}).get("type") in ("generate", "removeBackground")]
        work.sort(key=lambda r: (r["finished_at"] or r["started_at"] or float("inf")))
        ids = [i for r in work for i in json.loads(r["outputs"])]
        outputs = _outputs(ids, db.assets_by_ids(ids))[-12:]
        total = run["total"] or 1
        progress = sum((1.0 if r["status"] == "done" else r["progress"]) * node_units(nodes[r["node_id"]]) for r in work) / total
        current = next(({"nodeId": r["node_id"], "step": r["step"], "steps": r["steps"]} for r in work if r["status"] == "running"), None)
        number = None
        if run["workflow_id"]:  # 1 for the workflow's first run (of those still in the history), 2 for the next…
            number = db.one("SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ? AND created_at <= ?",
                            (run["workflow_id"], run["created_at"]))["n"]  # type: ignore[index]
        return {
            "id": run["id"], "kind": run["kind"], "workflowId": run["workflow_id"], "name": run["name"], "number": number,
            "status": run["status"],
            "total": run["total"], "done": run["done"], "progress": round(min(1.0, progress), 4),
            "createdAt": run["created_at"], "startedAt": run["started_at"], "finishedAt": run["finished_at"], "error": run["error"],
            "thumbs": [o["thumb"] for o in reversed(outputs[-4:])], "outputs": outputs, "current": current,
        }

    def detail(self, run: dict) -> dict:
        rows = db.all_rows("SELECT * FROM run_nodes WHERE run_id = ?", (run["id"],))
        ids = [i for r in rows for i in json.loads(r["outputs"])]
        assets = db.assets_by_ids(ids)
        return {**self.summary(run, rows), "graph": json.loads(run["graph"]), "folder": run["folder"],
                "nodes": {r["node_id"]: self._node_state(r, assets) for r in rows}}

    @staticmethod
    def _node_state(r: dict, assets: dict[str, dict]) -> dict:
        return {"status": r["status"], "progress": r["progress"], "step": r["step"], "steps": r["steps"], "error": r["error"],
                "outputs": _outputs(json.loads(r["outputs"]), assets)}

    def publish_run(self, run_id: str) -> None:
        run = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
        if run:
            broker.publish("run", self.summary(run))

    def _publish_node(self, run_id: str, node_id: str) -> None:
        r = db.one("SELECT * FROM run_nodes WHERE run_id = ? AND node_id = ?", (run_id, node_id))
        if r:
            ids = json.loads(r["outputs"])
            broker.publish("node", {"runId": run_id, "nodeId": node_id, **self._node_state(r, db.assets_by_ids(ids))})

    def _set_node(self, run_id: str, node_id: str, **values: Any) -> None:
        cols = ", ".join(f"{k} = ?" for k in values)
        db.execute(f"UPDATE run_nodes SET {cols} WHERE run_id = ? AND node_id = ?", (*values.values(), run_id, node_id))
        self._publish_node(run_id, node_id)

    # ---------- starting ----------
    def start(self, graph: dict, *, kind: str, name: str, folder: str, workflow_id: str | None = None,
              reuse: dict[str, list[str]] | None = None) -> str:
        nodes, _ = validate(graph)
        reuse = reuse or {}
        run_id, now = db.new_id(), time.time()
        total = sum(node_units(n) for n in nodes.values())
        done = sum(node_units(nodes[nid]) for nid in reuse if nid in nodes)
        db.execute("INSERT INTO runs(id, kind, workflow_id, name, graph, folder, status, total, done, created_at) VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
                   (run_id, kind, workflow_id, name[:120] or "Untitled", json.dumps(graph), folder, total, done, now))
        for nid, node in nodes.items():
            if node["type"] == "image":
                status, outputs = "done", [node["data"]["asset"]]
            elif nid in reuse:
                status, outputs = "done", reuse[nid]
            else:
                status, outputs = "waiting", []
            db.execute("INSERT INTO run_nodes(run_id, node_id, status, progress, outputs, finished_at) VALUES(?, ?, ?, ?, ?, ?)",
                       (run_id, nid, status, 1.0 if status == "done" else 0.0, json.dumps(outputs), now if status == "done" else None))
        self.publish_run(run_id)
        self._advance(run_id)
        return run_id

    def retry(self, run_id: str, fresh: bool = False) -> str:
        """Starts the run's own graph again. Resumes by default (finished images are kept); `fresh` makes everything anew."""
        run = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
        if not run:
            raise GraphError("That run no longer exists")
        reuse = {}
        for r in [] if fresh else db.all_rows("SELECT * FROM run_nodes WHERE run_id = ? AND status = 'done'", (run_id,)):
            ids = json.loads(r["outputs"])
            assets = db.assets_by_ids(ids)
            if ids and all(i in assets and Path(assets[i]["path"]).is_file() for i in ids):
                reuse[r["node_id"]] = ids
        nodes, _ = parse_graph(json.loads(run["graph"]))
        reuse = {nid: ids for nid, ids in reuse.items() if nodes.get(nid, {}).get("type") != "image"}
        return self.start(json.loads(run["graph"]), kind=run["kind"], name=run["name"], folder=run["folder"],
                          workflow_id=run["workflow_id"], reuse=reuse)

    def _advance(self, run_id: str) -> None:
        """Submits every waiting node whose inputs are done; finishes the run when nothing is left. No awaits: atomic."""
        run = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
        if not run or run["status"] not in ACTIVE:
            return
        nodes, edges = parse_graph(json.loads(run["graph"]))
        states = {r["node_id"]: r["status"] for r in db.all_rows("SELECT node_id, status FROM run_nodes WHERE run_id = ?", (run_id,))}
        canceled = run_id in self.canceled
        progressed = True
        while progressed:
            progressed = False
            for nid, status in states.items():
                if status != "waiting":
                    continue
                deps = [states[d] for d in ordered_inputs(nodes[nid], edges)]
                if canceled:
                    new = "canceled"
                elif any(s in ENDED for s in deps):
                    new = "skipped"
                elif all(s == "done" for s in deps):
                    new = "queued"
                else:
                    continue
                states[nid] = new
                progressed = True
                self._set_node(run_id, nid, status=new)
                if new == "queued":
                    task = asyncio.get_running_loop().create_task(self._run_node(run_id, nid))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
        if any(s in ("waiting", "queued", "running") for s in states.values()):
            return
        work = [states[nid] for nid, n in nodes.items() if n["type"] != "image"]
        if canceled:
            status = "canceled"
        elif all(s == "done" for s in work):
            status = "done"
        else:
            status = "failed"
        error = None
        if status == "failed":
            failed = db.one("SELECT error FROM run_nodes WHERE run_id = ? AND status = 'failed' AND error IS NOT NULL LIMIT 1", (run_id,))
            error = failed["error"] if failed else "Some steps didn't finish"
        db.execute("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?", (status, error, time.time(), run_id))
        self.canceled.discard(run_id)
        self.publish_run(run_id)

    # ---------- running one node ----------
    async def _run_node(self, run_id: str, node_id: str) -> None:
        try:
            await self._execute(run_id, node_id)
        except Canceled:
            self._set_node(run_id, node_id, status="canceled", finished_at=time.time())
        except Exception as e:  # noqa: BLE001 — any failure ends this node with a readable message
            if not isinstance(e, (EngineError, GraphError, OSError)):  # OSError: disk or permission, the message says it
                log.exception("node %s of run %s failed", node_id, run_id)
            self._set_node(run_id, node_id, status="failed", error=str(e) or type(e).__name__, finished_at=time.time())
        finally:
            self.units.pop((run_id, node_id), None)
            self._advance(run_id)

    def _input_assets(self, run_id: str, node: dict, edges: list[dict]) -> list[dict]:
        assets = []
        for source in ordered_inputs(node, edges):
            r = db.one("SELECT outputs FROM run_nodes WHERE run_id = ? AND node_id = ?", (run_id, source))
            ids = json.loads(r["outputs"]) if r else []
            asset = db.get_asset(ids[0]) if ids else None
            if not asset or not Path(asset["path"]).is_file():
                raise FileNotFoundError("An input image is missing")
            assets.append(asset)
        return assets

    async def _execute(self, run_id: str, node_id: str) -> None:
        run = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
        assert run
        nodes, edges = parse_graph(json.loads(run["graph"]))
        node = nodes[node_id]
        data = node.get("data") or {}
        inputs = self._input_assets(run_id, node, edges)
        folder = save_folder(data.get("folder") or run["folder"])
        prepared = [await asyncio.to_thread(files.prepare_input, Path(a["path"])) for a in inputs]
        engine_inputs = [p[0] for p in prepared]
        jobs: list[Job] = []
        try:
            if node["type"] == "removeBackground":
                user_prompt, negative, aspect, size, transparent, count = "Remove background", "", "auto", "1k", True, 1
                engine_prompt = REMOVE_BACKGROUND_PROMPT
                resolution = reference_resolution("1k", "original", engine_inputs)
                steps = QUALITY_STEPS.get(data.get("quality") or "standard", QUALITY_STEPS["standard"])
                sampling = Sampling(random.randint(0, 2**31 - 1), steps, 1.0, "euler", "simple")
            else:
                adv = {"seed": None, "negative": "", "cfg": None, "steps": None, "sampler": "euler", "scheduler": "simple",
                       "refDetail": "standard", **(data.get("advanced") or {})}
                user_prompt = str(data.get("prompt") or "").strip()
                aspect, size = data.get("aspect") or "auto", data.get("size") or "1k"
                transparent, count = bool(data.get("transparent")), node_units(node)
                if data.get("autoImprove"):
                    user_prompt, suggested, match = await self.enhance(user_prompt, [Path(a["path"]) for a in inputs], run_id=run_id)
                    if aspect == "auto" and suggested and not match:
                        aspect = suggested
                engine_prompt = normalize_references(user_prompt, len(inputs))
                if transparent:
                    engine_prompt = wrap_transparent(engine_prompt, edit=bool(inputs))
                negative = str(adv["negative"] or "").strip()
                cfg = float(adv["cfg"]) if adv["cfg"] is not None else (4.0 if negative else 1.0)
                samplers, schedulers = await self._samplers()
                sampling = Sampling(
                    seed=int(adv["seed"]) if adv["seed"] is not None else random.randint(0, 2**31 - 1),
                    steps=int(adv["steps"] or QUALITY_STEPS.get(data.get("quality") or "standard", 28)),
                    cfg=cfg,
                    sampler=adv["sampler"] if adv["sampler"] in samplers else "euler",
                    scheduler=adv["scheduler"] if adv["scheduler"] in schedulers else "simple")
                resolution = reference_resolution(size, adv["refDetail"], engine_inputs)

            self.units[(run_id, node_id)] = [0, count]
            self._set_node(run_id, node_id, steps=sampling.steps, step=0)
            for i in range(count):
                seed = sampling.seed + i
                graph = image_graph(engine_prompt, negative, engine_inputs, aspect=aspect, size=size, resolution=resolution,
                                    sampling=Sampling(seed, sampling.steps, sampling.cfg, sampling.sampler, sampling.scheduler),
                                    prefix=f"{config.INSTANCE}/{run_id}_{node_id}_{i}")
                jobs.append(await self._submit(Job("image", run_id, node_id, seed=seed, steps=sampling.steps), graph))

            meta_base = {"kind": node["type"], "prompt": user_prompt, "negative": negative, "steps": sampling.steps,
                         "cfg": sampling.cfg, "sampler": sampling.sampler, "scheduler": sampling.scheduler,
                         "transparent": transparent, "inputs": [asset_json(a)["name"] for a in inputs], "model": config.MODEL_LABEL}
            keep_alpha = transparent or any(i.has_alpha for i in engine_inputs)
            errors, saved = [], 0
            for finished in asyncio.as_completed([j.future for j in jobs]):
                job: Job = await finished
                if job.canceled:
                    continue
                if job.error:
                    errors.append(job.error)
                    continue
                asset = await self._save(run, node, job, folder, {**meta_base, "seed": job.seed}, keep_alpha, inputs)
                saved += 1
                r = db.one("SELECT outputs FROM run_nodes WHERE run_id = ? AND node_id = ?", (run_id, node_id))
                outputs = json.loads(r["outputs"]) + [asset["id"]]
                self.units[(run_id, node_id)][0] += 1
                db.execute("UPDATE runs SET done = done + 1 WHERE id = ?", (run_id,))
                self._set_node(run_id, node_id, outputs=json.dumps(outputs), progress=saved / count)
                self.publish_run(run_id)
            if run_id in self.canceled and saved < count:
                raise Canceled()
            if not saved:
                raise EngineError(errors[0] if errors else "No image was produced")
            self._set_node(run_id, node_id, status="done", progress=1.0, finished_at=time.time())
        except Exception:
            await self._drop(jobs)  # this node won't use them: don't leave its other variations running
            raise
        finally:
            for _, path in prepared:
                path.unlink(missing_ok=True)

    async def _drop(self, jobs: list[Job]) -> None:
        """Removes these prompts from the engine queue, or stops the one running."""
        for job in jobs:
            if job.future.done():
                continue
            try:
                await engine.cancel(job.prompt_id)
            except EngineError:
                pass
            if not job.started:  # removed from the queue: the engine sends nothing more for it
                self._finish(job, error="Canceled", canceled=True)

    async def _samplers(self) -> tuple[list[str], list[str]]:
        try:
            return await engine.samplers()
        except EngineError:
            return ["euler"], ["simple"]

    async def _submit(self, job: Job, graph: dict, front: bool = False) -> Job:
        """Queues a prompt; while the engine is offline, waits and tries again."""
        while True:
            if job.run_id and job.run_id in self.canceled:
                raise Canceled()
            try:
                job.prompt_id = await engine.submit(graph, front=front)
                break
            except EngineOffline:
                await asyncio.sleep(3)
        self.jobs[job.prompt_id] = job
        self.last_activity, self.unloaded = time.time(), False
        if job.run_id and job.run_id in self.canceled:  # Cancel came while this was being queued
            await self._drop([job])
            raise Canceled()
        return job

    async def _save(self, run: dict, node: dict, job: Job, folder: Path, meta: dict, keep_alpha: bool, inputs: list[dict]) -> dict:
        images = job.images
        if not images:  # e.g. the result came from the engine's cache: read it from the history
            history = await engine.history(job.prompt_id) or {}
            images = ((history.get("outputs") or {}).get("save") or {}).get("images") or []
        if not images:
            raise EngineError("The engine finished without an image")
        src = config.ENGINE_OUTPUT_DIR / images[0].get("subfolder", "") / images[0]["filename"]
        meta["createdAt"] = time.time()
        if node["type"] == "removeBackground":
            filename = f"{slug(Path(asset_json(inputs[0])['name']).stem, 60)}-cutout.png"
        else:
            filename = f"{slug(meta['prompt'])}-{time.strftime('%Y%m%d-%H%M%S')}-{job.seed}.png"
        target, width, height, alpha = await asyncio.to_thread(
            files.save_result, src, folder, filename, meta, keep_alpha or node["type"] == "removeBackground")
        for image in images:
            (config.ENGINE_OUTPUT_DIR / image.get("subfolder", "") / image["filename"]).unlink(missing_ok=True)
        asset = db.insert_asset(str(target), "generated", width, height, alpha, {**meta, "width": width, "height": height})
        db.upsert_folder(str(folder), folder.name, touch=True)
        broker.publish("folder", {"path": str(folder)})
        return asset

    # ---------- prompt improver ----------
    async def enhance(self, prompt: str, image_paths: list[Path], run_id: str | None = None,
                      disconnected: Callable[[], Awaitable[bool]] | None = None) -> tuple[str, str | None, bool]:
        """Rewrites a prompt with the official PE-T2I (no images) or PE-I2I model. Returns prompt, aspect, match-image."""
        status = model_status()
        if not status["enhancerI2I" if image_paths else "enhancerT2I"]:
            raise EngineError("The prompt improver model isn't installed (run ./studio setup)")
        prepared = [await asyncio.to_thread(files.prepare_input, p, True) for p in image_paths]
        try:
            text = normalize_references(prompt.strip(), len(prepared))
            graph = enhancer_graph(text, [p[0].name for p in prepared], seed=random.randint(0, 2**31 - 1))
            job = await self._submit(Job("enhance", run_id, None), graph, front=True)
            while not job.future.done():
                done, _ = await asyncio.wait({job.future}, timeout=0.5)
                if not done and disconnected and await disconnected():
                    await engine.cancel(job.prompt_id)
                    self._finish(job, error="Canceled", canceled=True)
                    raise Canceled()
            if job.canceled:
                raise Canceled()
            if job.error:
                raise EngineError(job.error)
            answer = job.text
            if answer is None:
                history = await engine.history(job.prompt_id) or {}
                answer = ((history.get("outputs") or {}).get(ENHANCER_OUTPUT_NODE) or {}).get("text")
            try:
                rewritten, aspect, follow = parse_enhancer("".join(answer or []))
            except ValueError as e:
                raise EngineError(f"The prompt improver gave an unexpected answer ({e})") from e
        finally:
            for _, path in prepared:
                path.unlink(missing_ok=True)
        if follow is None:
            return rewritten, aspect, False
        if 1 < follow <= len(image_paths):  # the canvas is another image: use that image's shape
            width, height, _ = await asyncio.to_thread(files.open_image, image_paths[follow - 1])
            return rewritten, nearest_aspect(f"{width}:{height}"), False
        return rewritten, None, True

    # ---------- cancel ----------
    async def cancel(self, run_id: str) -> None:
        run = db.one("SELECT status FROM runs WHERE id = ?", (run_id,))
        if not run or run["status"] not in ACTIVE:
            return
        self.canceled.add(run_id)
        for job in [j for j in self.jobs.values() if j.run_id == run_id]:
            try:
                await engine.cancel(job.prompt_id)
            except EngineError:
                pass
            if not job.started:  # removed from the queue: the engine sends nothing more for it
                self._finish(job, error="Canceled", canceled=True)
        self._advance(run_id)

    # ---------- engine events ----------
    def _finish(self, job: Job, error: str | None = None, canceled: bool = False) -> None:
        self.jobs.pop(job.prompt_id, None)
        job.error, job.canceled = error, canceled
        self.last_activity = time.time()
        if not job.future.done():
            job.future.set_result(job)

    def _job_running(self, job: Job) -> None:
        if job.started:
            return
        job.started = True
        if job.kind != "image" or not job.run_id or not job.node_id:
            return
        now = time.time()
        r = db.one("SELECT status FROM run_nodes WHERE run_id = ? AND node_id = ?", (job.run_id, job.node_id))
        if r and r["status"] == "queued":
            self._set_node(job.run_id, job.node_id, status="running", started_at=now)
        db.execute("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'", (now, job.run_id))
        self.publish_run(job.run_id)

    def on_message(self, kind: str, data: dict) -> None:
        job = self.jobs.get(data.get("prompt_id") or "")
        if not job:
            return
        if kind in ("execution_start", "executing", "progress"):
            self._job_running(job)
        if kind == "progress" and job.kind == "image" and data.get("node") == "sample" and job.run_id and job.node_id:
            job.step, job.steps = int(data.get("value", 0)), int(data.get("max", 0)) or job.steps
            finished, total = self.units.get((job.run_id, job.node_id), [0, 1])
            progress = (finished + (job.step / job.steps if job.steps else 0)) / total
            self._set_node(job.run_id, job.node_id, step=job.step, steps=job.steps, progress=round(progress, 4))
            self.publish_run(job.run_id)
        elif kind == "executed":
            output = data.get("output") or {}
            if data.get("node") == "save":
                job.images = output.get("images") or []
            elif data.get("node") == ENHANCER_OUTPUT_NODE:
                job.text = output.get("text")
        elif kind == "execution_success":
            self._finish(job)
        elif kind == "execution_error":
            message = str(data.get("exception_message") or "").strip().splitlines()
            self._finish(job, error=f"{data.get('node_type') or 'Engine'}: {message[0] if message else 'failed'}")
        elif kind == "execution_interrupted":
            self._finish(job, error="Canceled", canceled=True)

    def on_preview(self, prompt_id: str, node_id: str, mime: str, image: bytes) -> None:
        job = self.jobs.get(prompt_id)
        if not job or job.kind != "image" or not job.run_id or not job.node_id:
            return
        key, now = (job.run_id, job.node_id), time.monotonic()
        if now - self._last_preview.get(key, 0.0) < PREVIEW_INTERVAL:
            return
        self._last_preview[key] = now
        self._job_running(job)
        broker.publish("preview", {"runId": job.run_id, "nodeId": job.node_id,
                                   "image": f"data:{mime};base64,{base64.b64encode(image).decode()}"})

    async def on_reconnect(self) -> None:
        """After the WebSocket was down, settle prompts whose events were missed."""
        if self._orphans:
            self._orphans = False
            try:
                await engine.clear()
            except EngineError:
                pass
        for job in list(self.jobs.values()):
            try:
                history = await engine.history(job.prompt_id)
                if history:
                    status = (history.get("status") or {}).get("status_str")
                    outputs = history.get("outputs") or {}
                    if status == "success":
                        job.images = (outputs.get("save") or {}).get("images") or []
                        job.text = (outputs.get(ENHANCER_OUTPUT_NODE) or {}).get("text")
                        self._finish(job)
                    elif status == "error":
                        self._finish(job, error="The engine reported an error")
                elif job.prompt_id not in await engine.queued_ids():
                    self._finish(job, error="The engine restarted while this was running")
            except EngineError:
                return

    # ---------- idle unload ----------
    async def unload_when_idle(self) -> None:
        last_purge = time.time()
        while True:
            await asyncio.sleep(30)
            if time.time() - last_purge >= 3600:  # the app runs for weeks: empty the 30-day trash hourly, not only at startup
                last_purge = time.time()
                files.purge_trash()
            if self.jobs or self.unloaded or not engine.online or config.IDLE_UNLOAD_SECONDS <= 0:
                continue
            if time.time() - self.last_activity >= config.IDLE_UNLOAD_SECONDS:
                try:
                    await engine.free()
                    self.unloaded = True
                    log.info("engine idle for %d min: models unloaded", config.IDLE_UNLOAD_SECONDS // 60)
                except EngineError:
                    pass


executor = Executor()
