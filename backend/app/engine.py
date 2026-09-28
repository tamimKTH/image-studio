"""Client for the native ComfyUI engine: HTTP to queue prompts, one WebSocket for progress and previews."""
import asyncio
import json
import logging
import struct
import uuid
from typing import Protocol

import aiohttp

from . import config
from .events import broker

log = logging.getLogger("studio.engine")

PREVIEW_WITH_METADATA = 4  # protocol.BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=60)


class EngineError(Exception):
    """The engine rejected a prompt or failed while running it."""


class EngineOffline(EngineError):
    """The engine can't be reached; the work should wait and try again."""


class Listener(Protocol):
    def on_message(self, kind: str, data: dict) -> None: ...
    def on_preview(self, prompt_id: str, node_id: str, mime: str, image: bytes) -> None: ...
    async def on_reconnect(self) -> None: ...


def _describe(body: dict) -> str:
    error = body.get("error")
    parts = [error.get("message", "") if isinstance(error, dict) else str(error or "")]
    for node in (body.get("node_errors") or {}).values():
        for e in node.get("errors", []):
            parts.append(f"{node.get('class_type', 'node')}: {e.get('message', '')} {e.get('details', '')}".strip())
    return " · ".join(p for p in parts if p) or "The engine rejected the job"


class Engine:
    def __init__(self, url: str) -> None:
        self.url = url
        self.client_id = uuid.uuid4().hex
        self.online = False
        self.device: str | None = None
        self.version: str | None = None
        self.queue = 0
        self.error: str | None = None
        self.running_prompt: str | None = None
        self._session: aiohttp.ClientSession | None = None
        self._listener: Listener | None = None
        self._task: asyncio.Task | None = None
        self._samplers: tuple[list[str], list[str]] | None = None

    # ---------- lifecycle ----------
    async def start(self, listener: Listener) -> None:
        self._listener = listener
        # No session-wide total timeout: it would also cut the long-lived WebSocket. HTTP calls set their own.
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=5))
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self._session:
            await self._session.close()

    def status(self) -> dict:
        return {"online": self.online, "device": self.device, "queue": self.queue, "version": self.version, "error": self.error}

    def _publish(self) -> None:
        broker.publish("engine", self.status())

    async def _run(self) -> None:
        delay = 1.0
        assert self._session and self._listener
        while True:
            try:
                async with self._session.ws_connect(f"{self.url}/ws?clientId={self.client_id}", max_msg_size=0, heartbeat=30) as ws:
                    # Must be the first message, or previews arrive without their prompt id.
                    await ws.send_str(json.dumps({"type": "feature_flags", "data": {"supports_preview_metadata": True}}))
                    await self._refresh_info()
                    self.online, self.error, delay = True, None, 1.0
                    self._publish()
                    await self._listener.on_reconnect()
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            self._on_text(msg.data)
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            self._on_binary(msg.data)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                self.error = "The engine closed the connection"
            except asyncio.CancelledError:
                raise
            except Exception as e:  # connection refused, reset, bad handshake…
                self.error = str(e) or type(e).__name__
            if self.online:
                log.warning("engine offline: %s", self.error)
                self.online, self.running_prompt = False, None
                self._publish()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 10.0)

    async def _refresh_info(self) -> None:
        stats = await self._get("/system_stats")
        devices = stats.get("devices") or [{}]
        self.device = devices[0].get("type")
        self.version = (stats.get("system") or {}).get("comfyui_version")
        info = await self._get("/prompt")
        self.queue = int((info.get("exec_info") or {}).get("queue_remaining", 0))

    def _on_text(self, raw: str) -> None:
        msg = json.loads(raw)
        kind, data = msg.get("type"), msg.get("data") or {}
        if kind == "status":
            queue = ((data.get("status") or {}).get("exec_info") or {}).get("queue_remaining")
            if queue is not None and queue != self.queue:
                self.queue = int(queue)
                self._publish()
        elif kind == "execution_start":
            self.running_prompt = data.get("prompt_id")
        elif kind in ("execution_success", "execution_error", "execution_interrupted"):
            if data.get("prompt_id") == self.running_prompt:
                self.running_prompt = None
        assert self._listener
        self._listener.on_message(kind, data)

    def _on_binary(self, raw: bytes) -> None:
        if len(raw) < 8 or struct.unpack(">I", raw[:4])[0] != PREVIEW_WITH_METADATA:
            return
        size = struct.unpack(">I", raw[4:8])[0]
        meta = json.loads(raw[8:8 + size])
        assert self._listener
        self._listener.on_preview(meta.get("prompt_id", ""), meta.get("node_id", ""), meta.get("image_type", "image/jpeg"), raw[8 + size:])

    # ---------- HTTP ----------
    async def _get(self, path: str) -> dict:
        assert self._session
        try:
            async with self._session.get(self.url + path, timeout=HTTP_TIMEOUT) as r:
                return await r.json(content_type=None)
        except (aiohttp.ClientConnectionError, TimeoutError) as e:
            raise EngineOffline(str(e) or "The engine did not answer") from e

    async def _post(self, path: str, body: dict) -> tuple[int, dict]:
        assert self._session
        try:
            async with self._session.post(self.url + path, json=body, timeout=HTTP_TIMEOUT) as r:
                text = await r.text()
                return r.status, (json.loads(text) if text.strip().startswith(("{", "[")) else {})
        except (aiohttp.ClientConnectionError, TimeoutError) as e:
            raise EngineOffline(str(e) or "The engine did not answer") from e

    async def submit(self, graph: dict, front: bool = False) -> str:
        status, body = await self._post("/prompt", {"prompt": graph, "client_id": self.client_id, "front": front})
        if status != 200 or "prompt_id" not in body:
            raise EngineError(_describe(body))
        return body["prompt_id"]

    async def history(self, prompt_id: str) -> dict | None:
        return (await self._get(f"/history/{prompt_id}")).get(prompt_id)

    async def queued_ids(self) -> set[str]:
        q = await self._get("/queue")
        return {item[1] for item in q.get("queue_running", []) + q.get("queue_pending", [])}

    async def cancel(self, prompt_id: str) -> None:
        """Removes a waiting prompt, or stops it if it is the one running."""
        await self._post("/queue", {"delete": [prompt_id]})
        await self._post("/interrupt", {"prompt_id": prompt_id})

    async def clear(self) -> None:
        """Drops every waiting prompt and stops the running one (work left over from a previous app run)."""
        await self._post("/queue", {"clear": True})
        await self._post("/interrupt", {})

    async def free(self) -> None:
        await self._post("/free", {"unload_models": True, "free_memory": True})

    async def samplers(self) -> tuple[list[str], list[str]]:
        if self._samplers is None:
            info = (await self._get("/object_info/KSampler"))["KSampler"]["input"]["required"]
            self._samplers = (list(info["sampler_name"][0]), list(info["scheduler"][0]))
        return self._samplers


def model_status() -> dict[str, bool]:
    """Which model files are present, checked on disk (the engine loads them lazily)."""
    def has(folders: tuple[str, ...], name: str) -> bool:
        return any((config.MODELS_DIR / f / name).is_file() for f in folders)

    return {
        "generator": has(("diffusion_models", "unet"), config.GENERATOR),
        "textEncoder": has(("text_encoders", "clip"), config.TEXT_ENCODER),
        "vae": has(("vae",), config.VAE),
        "enhancerT2I": has(("text_encoders", "clip"), config.ENHANCER["t2i"]),
        "enhancerI2I": has(("text_encoders", "clip"), config.ENHANCER["i2i"]),
    }


engine = Engine(config.ENGINE_URL)
