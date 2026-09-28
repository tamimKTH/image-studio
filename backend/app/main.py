"""Image Studio API server: FastAPI app, background executor, and the built web app."""
import asyncio
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from . import config, db, files
from .api import router
from .engine import EngineError, engine
from .executor import GraphError, executor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _host_name(host: str) -> str:
    """'127.0.0.1:4747' → '127.0.0.1'; '[::1]:4747' → '::1'."""
    return urlsplit(f"//{host.strip()}").hostname or ""


class LocalOnly:
    """Serves only this Mac's own pages.

    A web page whose name is re-pointed at 127.0.0.1 (DNS rebinding) sends its own Host name: refused.
    Other sites may not change anything (Origin), nor pull the API into their pages (Sec-Fetch-Site).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            problem = None
            if _host_name(headers.get("host", "")) not in LOCAL_HOSTS:
                problem = (400, "Open Image Studio at http://127.0.0.1:4747")
            elif scope["method"] not in SAFE_METHODS and origin is not None and urlsplit(origin).netloc.lower() != headers.get("host", "").lower():
                # Changes may only come from this very page (same host and port), not from another local site.
                problem = (403, "Other websites can't use Image Studio")
            elif (scope["path"].startswith("/api/") and headers.get("sec-fetch-site") == "cross-site"
                  and headers.get("sec-fetch-mode") != "navigate"):
                problem = (403, "Other websites can't use Image Studio")
            if problem:
                await JSONResponse({"error": problem[1]}, status_code=problem[0])(scope, receive, send)
                return

            async def send_no_framing(message: dict) -> None:
                # Other sites may not show the app inside their pages (clickjacking).
                if message["type"] == "http.response.start":
                    message["headers"] = [*message.get("headers", []), (b"x-frame-options", b"DENY"),
                                          (b"content-security-policy", b"frame-ancestors 'none'")]
                await send(message)

            await self.app(scope, receive, send_no_framing)
            return
        await self.app(scope, receive, send)


@asynccontextmanager
async def lifespan(_: FastAPI):
    for folder in (config.UPLOADS_DIR, config.THUMBS_DIR, config.ENGINE_INPUT_DIR / config.INSTANCE, config.ENGINE_OUTPUT_DIR):
        folder.mkdir(parents=True, exist_ok=True)
    db.init()
    files.purge_trash()
    if db.get_setting("defaultFolder") is None:
        config.DEFAULT_FOLDER.mkdir(parents=True, exist_ok=True)
        db.set_setting("defaultFolder", str(config.DEFAULT_FOLDER))
        db.upsert_folder(str(config.DEFAULT_FOLDER), config.DEFAULT_FOLDER.name, touch=True)
    executor.recover()
    await engine.start(executor)
    idle = asyncio.create_task(executor.unload_when_idle())
    yield
    idle.cancel()
    await engine.stop()


app = FastAPI(title="Image Studio", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LocalOnly)


@app.exception_handler(StarletteHTTPException)
async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(x) for x in first.get("loc", [])[1:])
    return JSONResponse({"error": f"Invalid {where or 'request'}: {first.get('msg', 'check the values')}"}, status_code=422)


@app.exception_handler(GraphError)
async def graph_error(_: Request, exc: GraphError) -> JSONResponse:
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(EngineError)
async def engine_error(_: Request, exc: EngineError) -> JSONResponse:
    return JSONResponse({"error": str(exc)}, status_code=502)


@app.exception_handler(Exception)
async def unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    """Anything unforeseen still answers in the API's JSON shape (the server logs the traceback)."""
    lines = str(exc).strip().splitlines()
    return JSONResponse({"error": f"Something went wrong: {(lines[0] if lines else type(exc).__name__)[:200]}"}, status_code=500)


app.include_router(router)


@app.get("/{path:path}", include_in_schema=False)
async def web_app(path: str) -> FileResponse:
    """The built frontend; unknown paths get index.html so client-side routes work on reload."""
    if path.startswith("api/"):
        raise HTTPException(404, "Not found")
    root = config.STATIC_DIR.resolve()
    candidate = (root / path).resolve()
    if path and candidate.is_file() and root in candidate.parents:
        immutable = path.startswith("assets/")
        return FileResponse(candidate, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
    index = root / "index.html"
    if not index.is_file():
        raise HTTPException(404, "The web app isn't built (npm run build in frontend/)")
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
