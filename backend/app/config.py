"""Paths and constants. Inside Docker the home folder is mounted at the same absolute path."""
import os
from pathlib import Path


def _path(env: str, default: Path) -> Path:
    value = os.environ.get(env)
    return Path(value) if value else default


HOME = _path("STUDIO_HOME", Path(os.path.expanduser("~")))
RUNTIME_DIR = _path("STUDIO_RUNTIME_DIR", HOME / "Library" / "Application Support" / "ImageStudio")
MODELS_DIR = _path("STUDIO_MODELS_DIR", HOME / "ComfyUI-Shared" / "models")
ENGINE_URL = os.environ.get("STUDIO_ENGINE_URL", "http://127.0.0.1:8199").rstrip("/")

_repo_static = Path(__file__).resolve().parents[2] / "frontend" / "dist"
STATIC_DIR = _path("STUDIO_STATIC_DIR", Path("/srv/static") if Path("/srv/static").is_dir() else _repo_static)

APP_DIR = RUNTIME_DIR / "app"
DB_PATH = APP_DIR / "studio.db"
UPLOADS_DIR = APP_DIR / "uploads"
THUMBS_DIR = APP_DIR / "thumbs"
ENGINE_INPUT_DIR = RUNTIME_DIR / "io" / "input"
ENGINE_OUTPUT_DIR = RUNTIME_DIR / "io" / "output"
DEFAULT_FOLDER = HOME / "Pictures" / "Image Studio"
VOLUMES_DIR = Path("/Volumes")
TRASH_DIR = HOME / ".Trash"
PROMPTS_DIR = Path(__file__).parent / "prompts"

# Model files, relative to MODELS_DIR (see docs/changes/2026-09-28-image-studio/spec.md).
GENERATOR = "qwen-image-2.1-UC-Q8_0.gguf"
TEXT_ENCODER = "qwen3vl_8b.dequant-bf16.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"
ENHANCER = {
    "t2i": "qwen3.5_9b_qwen_image_2.1_pe_t2i.dequant-bf16.safetensors",
    "i2i": "qwen3.5_9b_qwen_image_2.1_pe_i2i.dequant-bf16.safetensors",
}
MODEL_LABEL = "Qwen-Image 2.1 Uncensored Q8"

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
UPLOAD_EXTENSIONS = IMAGE_EXTENSIONS | {".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
MAX_INPUTS = 10
IDLE_UNLOAD_SECONDS = 600
