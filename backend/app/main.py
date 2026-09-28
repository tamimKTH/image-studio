"""Image Studio API server: FastAPI app, background executor, and the built web app."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, db
from .api import router
from .engine import EngineError, engine
from .executor import GraphError, executor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    for folder in (config.UPLOADS_DIR, config.THUMBS_DIR, config.ENGINE_INPUT_DIR / "studio", config.ENGINE_OUTPUT_DIR):
        folder.mkdir(parents=True, exist_ok=True)
    db.init()
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
