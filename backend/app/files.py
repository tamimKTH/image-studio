"""Mac folders and image files: safe paths, listings, thumbnails, saving results, the app trash."""
import hashlib
import json
import os
import shutil
import time
import uuid
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlencode

from fastapi import HTTPException
from PIL import Image, ImageOps
from PIL.PngImagePlugin import PngInfo
from pillow_heif import register_heif_opener

from . import config, db
from .graphs import EngineInput

Image.MAX_IMAGE_PIXELS = 400_000_000  # large photos are fine; this only guards against decompression bombs
register_heif_opener()  # iPhone photos (HEIC)
ALPHA_OPAQUE = 250  # alpha at or above this counts as opaque
# macOS packages look like folders but must not be browsed into or saved in.
PACKAGE_SUFFIXES = {".photoslibrary", ".app", ".bundle", ".framework", ".plugin", ".kext", ".musiclibrary", ".tvlibrary",
                    ".imovielibrary", ".fcpbundle", ".logicx", ".band", ".pkg", ".lrlibrary", ".aplibrary", ".theater",
                    ".dvdmedia", ".rtfd", ".xcodeproj", ".xcworkspace"}


# ---------- safe paths ----------
def _app_data(p: Path) -> bool:
    """Inside Image Studio's own runtime or data folder (uploads, thumbnails, trash, engine files)."""
    return any(p == base or base in p.parents for base in (config.RUNTIME_DIR.resolve(), config.APP_DIR.resolve()))


def is_allowed(p: Path) -> bool:
    """Home (except ~/Library and hidden folders) and mounted volumes; the app's own data can always be read."""
    if _app_data(p):
        return True
    home = config.HOME.resolve()
    if p == home or home in p.parents:
        parts = p.relative_to(home).parts
        # casefold: the Mac's disk ignores case, so ~/LIBRARY is ~/Library
        return not (parts and parts[0].casefold() == "library") and not any(part.startswith(".") for part in parts)
    if config.VOLUMES_DIR in p.parents:
        return not any(part.startswith(".") for part in p.relative_to(config.VOLUMES_DIR).parts)
    return False


def safe_path(raw: str | None, must_exist: bool = True) -> Path:
    if not raw:
        raise HTTPException(400, "A path is required")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise HTTPException(400, "Use a full path")
    resolved = p.resolve()
    if not is_allowed(resolved):
        raise HTTPException(403, "Image Studio can't use that location")
    if must_exist and not resolved.exists():
        raise HTTPException(404, "That file or folder no longer exists")
    return resolved


def safe_dir(raw: str | None) -> Path:
    p = safe_path(raw)
    if not p.is_dir():
        raise HTTPException(400, "That is not a folder")
    return p


def safe_dest(raw: str | None) -> Path:
    """A folder images may be saved in (it may not exist yet): allowed, and outside the app's own data."""
    p = safe_path(raw, must_exist=False)
    if _app_data(p):
        raise HTTPException(403, "Choose a folder outside Image Studio's own data")
    return p


def safe_dest_dir(raw: str | None) -> Path:
    p = safe_dest(raw)
    if not p.is_dir():
        raise HTTPException(400 if p.exists() else 404, "That is not a folder" if p.exists() else "That folder no longer exists")
    return p


def file_url(path: str | Path) -> str:
    return "/api/file?" + urlencode({"path": str(path)})


def thumb_url(path: str | Path) -> str:
    return "/api/thumb?" + urlencode({"path": str(path)})


# ---------- browsing ----------
def places(default_folder: str) -> list[dict]:
    home = config.HOME.resolve()
    items = [("Home", home, "home"), ("Desktop", home / "Desktop", "desktop"), ("Documents", home / "Documents", "documents"),
             ("Downloads", home / "Downloads", "downloads"), ("Pictures", home / "Pictures", "pictures"),
             ("Image Studio", Path(default_folder), "studio")]
    out = [{"name": n, "path": str(p), "kind": k} for n, p, k in items if p.is_dir()]
    if config.VOLUMES_DIR.is_dir():
        for v in sorted(config.VOLUMES_DIR.iterdir(), key=lambda x: x.name.casefold()):
            try:
                if not v.name.startswith(".") and v.is_dir() and is_allowed(v.resolve()):
                    out.append({"name": v.name, "path": str(v.resolve()), "kind": "volume"})
            except OSError:
                continue
    return out


def _base(p: Path) -> tuple[Path, str] | None:
    home = config.HOME.resolve()
    if p == home or home in p.parents:
        return home, "Home"
    if config.VOLUMES_DIR in p.parents:
        name = p.relative_to(config.VOLUMES_DIR).parts[0]
        return config.VOLUMES_DIR / name, name
    return None


def list_dir(raw: str | None, default_folder: str) -> dict:
    p = safe_dir(raw) if raw else config.HOME.resolve()
    dirs = []
    try:
        with os.scandir(p) as entries:
            for e in entries:
                if (e.name.startswith(".") or Path(e.name).suffix.casefold() in PACKAGE_SUFFIXES
                        or (p == config.HOME.resolve() and e.name.casefold() == "library")):
                    continue
                try:
                    if not e.is_dir():
                        continue
                    resolved = Path(e.path).resolve()
                except OSError:
                    continue
                if is_allowed(resolved):
                    dirs.append({"name": e.name, "path": str(resolved)})
    except PermissionError:
        raise HTTPException(403, "macOS didn't allow reading this folder")
    dirs.sort(key=lambda d: d["name"].casefold())

    base = _base(p)
    crumbs = [{"name": p.name or str(p), "path": str(p)}]
    parent = None
    if base:
        root, label = base
        crumbs, current = [{"name": label, "path": str(root)}], root
        for part in p.relative_to(root).parts:
            current = current / part
            crumbs.append({"name": part, "path": str(current)})
        if p != root:
            parent = str(p.parent)
    return {"path": str(p), "name": crumbs[-1]["name"], "parent": parent, "crumbs": crumbs, "dirs": dirs,
            "places": places(default_folder)}


def make_dir(parent: str, name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or name.startswith(".") or "/" in name or ":" in name or len(name) > 200:
        raise HTTPException(400, "Choose a different folder name")
    target = safe_dest_dir(parent) / name
    if target.exists():
        raise HTTPException(409, f"“{name}” already exists here")
    try:
        target.mkdir()
    except OSError as e:
        raise HTTPException(400, f"Couldn't create the folder: {e.strerror or e}")
    return str(target)


# ---------- images in folders ----------
def image_entries(folder: Path) -> list[tuple[str, str, float]]:
    """(path, name, mtime) of the images directly inside `folder`, newest first."""
    out = []
    try:
        with os.scandir(folder) as entries:
            for e in entries:
                if e.name.startswith(".") or Path(e.name).suffix.lower() not in config.IMAGE_EXTENSIONS:
                    continue
                try:
                    if e.is_file():
                        out.append((e.path, e.name, e.stat().st_mtime))
                except OSError:
                    continue
    except OSError:
        return []
    out.sort(key=lambda x: x[2], reverse=True)
    return out


@lru_cache(maxsize=4096)
def image_size(path: str, mtime: float) -> tuple[int | None, int | None]:
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None, None


def _has_alpha(im: Image.Image) -> bool:
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        return im.convert("RGBA").getchannel("A").getextrema()[0] < ALPHA_OPAQUE
    return False


def _flatten(im: Image.Image) -> Image.Image:
    rgba = im.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("RGB")


def open_image(path: Path) -> tuple[int, int, bool]:
    """Checks a file is a readable image; returns width, height and whether it has real transparency."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        return im.width, im.height, _has_alpha(im)


# ---------- thumbnails ----------
def thumbnail(path: Path) -> Path:
    st = path.stat()
    key = hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    out = config.THUMBS_DIR / f"{key}.webp"
    if not out.exists():
        config.THUMBS_DIR.mkdir(parents=True, exist_ok=True)
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((512, 512), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if _has_alpha(im) else "RGB")
            tmp = out.with_name(f"{key}.{uuid.uuid4().hex}.tmp")
            im.save(tmp, "WEBP", quality=82, method=4)
            tmp.replace(out)
    return out


# ---------- engine inputs and results ----------
def prepare_input(src: Path, flatten: bool = False) -> tuple[EngineInput, Path]:
    """Copies an image into the engine's input folder as PNG (orientation applied); returns it and its path."""
    name = f"{config.INSTANCE}/{uuid.uuid4().hex}.png"
    dest = config.ENGINE_INPUT_DIR / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        alpha = _has_alpha(im)
        if alpha and flatten:
            im, alpha = _flatten(im), False
        elif im.mode not in ("RGB", "RGBA") or (im.mode == "RGBA" and not alpha):
            im = im.convert("RGBA" if alpha else "RGB")
        im.save(dest, "PNG", compress_level=1)
        return EngineInput(name=name, has_alpha=alpha, pixels=im.width * im.height), dest


def unique_path(target: Path, separator: str = "-") -> Path:
    if not target.exists():
        return target
    n = 2
    while (candidate := target.with_name(f"{target.stem}{separator}{n}{target.suffix}")).exists():
        n += 1
    return candidate


def save_result(src: Path, folder: Path, filename: str, meta: dict, keep_alpha: bool) -> tuple[Path, int, int, bool]:
    """Writes an engine result as PNG with the settings in a 'studio' text chunk. Alpha is kept only when meaningful."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise OSError(f"Couldn't save in “{folder}”: {e.strerror or e}") from e
    with Image.open(src) as im:
        im.load()
        alpha = keep_alpha and _has_alpha(im)
        out = im.convert("RGBA") if alpha else (_flatten(im) if im.mode in ("RGBA", "LA", "P") else im.convert("RGB"))
        meta = {**meta, "width": out.width, "height": out.height}
        info = PngInfo()
        info.add_text("studio", json.dumps(meta))
        info.add_text("Software", f"Image Studio · {config.MODEL_LABEL}")
        target = unique_path(folder / filename)
        out.save(target, "PNG", pnginfo=info, compress_level=6)
        return target, out.width, out.height, alpha


def file_info(p: Path) -> dict:
    st = p.stat()
    meta = None
    with Image.open(p) as im:
        width, height = im.size
        raw = im.info.get("studio")
        if raw:
            try:
                meta = json.loads(raw)
            except ValueError:
                meta = None
    return {"path": str(p), "name": p.name, "width": width, "height": height, "bytes": st.st_size, "mtime": st.st_mtime, "meta": meta}


def convert_upload(p: Path) -> Path:
    """HEIC photos are stored as PNG so browsers can show them; other uploads stay as they are."""
    if p.suffix.lower() not in (".heic", ".heif"):
        return p
    target = p.with_suffix(".png")
    with Image.open(p) as im:
        im = ImageOps.exif_transpose(im)
        im.convert("RGBA" if _has_alpha(im) else "RGB").save(target, "PNG", compress_level=6)
    p.unlink(missing_ok=True)
    return target


# ---------- the app trash ----------
def _in_trash(p: Path) -> bool:
    trash = config.TRASH_DIR.resolve()
    return p == trash or trash in p.parents


def move_to_trash(p: Path) -> str:
    """Moves an image into the app trash and returns the id that restores it."""
    if _in_trash(p):
        raise HTTPException(400, "That image is already deleted")
    trash_id = db.new_id()
    target = config.TRASH_DIR / f"{trash_id}-{p.name}"
    try:
        config.TRASH_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(target))
    except OSError as e:
        raise HTTPException(409, f"Couldn't delete “{p.name}”: {e.strerror or e}") from e
    db.execute("INSERT INTO trash(id, original_path, trash_path, created_at) VALUES(?, ?, ?, ?)",
               (trash_id, str(p), str(target), time.time()))
    return trash_id


def restore_from_trash(trash_id: str) -> Path:
    """Puts a deleted image back where it was (with a new name if that name is taken again)."""
    row = db.one("SELECT * FROM trash WHERE id = ?", (trash_id,))
    source = Path(row["trash_path"]) if row else None
    if not row or not source or not source.is_file():
        raise HTTPException(404, "That image is no longer in the trash")
    original = Path(row["original_path"])
    target = unique_path(safe_path(str(original.parent), must_exist=False) / original.name)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(target))
    except OSError as e:
        raise HTTPException(409, f"Couldn't restore “{target.name}”: {e.strerror or e}") from e
    db.execute("DELETE FROM trash WHERE id = ?", (trash_id,))
    return target


def purge_trash() -> None:
    """Deletes images that have been in the trash longer than TRASH_DAYS."""
    cutoff = time.time() - config.TRASH_DAYS * 86400
    for row in db.all_rows("SELECT * FROM trash WHERE created_at < ?", (cutoff,)):
        Path(row["trash_path"]).unlink(missing_ok=True)
        db.execute("DELETE FROM trash WHERE id = ?", (row["id"],))
