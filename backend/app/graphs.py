"""Engine prompt graphs (ComfyUI API format) for Qwen-Image 2.1, proven on this Mac 2026-09-28."""
import json
import math
import re
from dataclasses import dataclass
from typing import Any

from . import config

# Official 2K sizes, and ~1 MP sizes with the same aspect (multiples of 32).
SIZES: dict[str, dict[str, tuple[int, int]]] = {
    "2k": {"1:1": (2048, 2048), "4:3": (2400, 1792), "3:4": (1792, 2400), "3:2": (2528, 1696),
           "2:3": (1696, 2528), "16:9": (2752, 1536), "9:16": (1536, 2752)},
    "1k": {"1:1": (1024, 1024), "4:3": (1184, 896), "3:4": (896, 1184), "3:2": (1248, 832),
           "2:3": (832, 1248), "16:9": (1376, 768), "9:16": (768, 1376)},
}
ASPECTS = tuple(SIZES["1k"])
QUALITY_STEPS = {"fast": 16, "standard": 28, "best": 40}
REMOVE_BACKGROUND_PROMPT = "Remove the background, and output a PNG image"
ORIGINAL_SIZE_CAP = 4_200_000  # pixels; bigger inputs are read at the 2K budget instead of their own size

_REFERENCE = re.compile(r"(?<![<\w])(?:image|img|picture|photo|pic)\s?#?\s?(\d{1,2})(?![\w>])", re.IGNORECASE)


def normalize_references(prompt: str, n_images: int) -> str:
    """'put image 2 on image 1' → 'put <image2> on <image1>' for the numbers that exist."""
    if n_images == 0:
        return prompt

    def repl(m: re.Match) -> str:
        n = int(m.group(1))
        return f"<image{n}>" if 1 <= n <= n_images else m.group(0)

    return _REFERENCE.sub(repl, prompt)


def wrap_transparent(prompt: str, edit: bool) -> str:
    if edit:
        text = prompt.rstrip()
        return f"{text}{'' if text.endswith(('.', '!', '?')) else '.'} Output a PNG image with a transparent background."
    subject = prompt.strip().rstrip(".!")
    return f"This is an RGBA image with transparency. {subject}. The image has alpha channel and the background is transparent."


@dataclass
class EngineInput:
    """An input image copied into the engine's input folder."""
    name: str          # path relative to the engine input folder, e.g. "studio/ab12.png"
    has_alpha: bool    # real transparency (some pixel below fully opaque)
    pixels: int


@dataclass
class Sampling:
    seed: int
    steps: int
    cfg: float
    sampler: str
    scheduler: str


def _loaders() -> dict[str, Any]:
    return {
        "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": config.GENERATOR}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": config.TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": config.VAE}},
        "cache": {"class_type": "QwenImage21Cache", "inputs": {"model": ["unet", 0], "device": "auto", "dtype": "default"}},
    }


def reference_resolution(size: str, ref_detail: str, inputs: list[EngineInput]) -> int:
    """Pixel budget (side of a square) the encoder resizes reference images to; 0 keeps their size."""
    if ref_detail == "original":
        return 2048 if any(i.pixels > ORIGINAL_SIZE_CAP for i in inputs) else 0
    return 2048 if size == "2k" or ref_detail == "high" else 1024


def image_graph(prompt: str, negative: str, inputs: list[EngineInput], *, aspect: str, size: str,
                resolution: int, sampling: Sampling, prefix: str) -> dict[str, Any]:
    """Text-to-image (no inputs) or edit with up to 10 reference images (image 1 is the canvas)."""
    g = _loaders()
    enc: dict[str, Any] = {"clip": ["clip", 0], "prompt": prompt, "negative_prompt": negative, "resolution": resolution}
    for i, item in enumerate(inputs, 1):
        g[f"load{i}"] = {"class_type": "LoadImage", "inputs": {"image": item.name}}
        source: list[Any] = [f"load{i}", 0]
        if item.has_alpha:  # keep the alpha channel for transparent-layer edits
            g[f"alpha{i}"] = {"class_type": "JoinImageWithAlpha", "inputs": {"image": [f"load{i}", 0], "alpha": [f"load{i}", 1]}}
            source = [f"alpha{i}", 0]
        enc[f"images.image_{i}"] = source
    if inputs:
        enc["vae"] = ["vae", 0]
    g["enc"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc}

    if inputs and aspect == "auto":
        latent: list[Any] = ["enc", 2]  # follows image 1, so the edit doesn't shift
    else:
        width, height = SIZES[size]["1:1" if aspect == "auto" else aspect]
        g["latent"] = {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
        latent = ["latent", 0]

    g["sample"] = {"class_type": "KSampler", "inputs": {
        "model": ["cache", 0], "positive": ["enc", 0], "negative": ["enc", 1], "latent_image": latent,
        "seed": sampling.seed, "steps": sampling.steps, "cfg": sampling.cfg,
        "sampler_name": sampling.sampler, "scheduler": sampling.scheduler, "denoise": 1.0}}
    g["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}}
    g["save"] = {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": prefix}}
    return g


# ---------- prompt enhancer (official Qwen-Image-2.1-PE-T2I / PE-I2I) ----------
ENHANCER_OUTPUT_NODE = "show"
I2I_LANGUAGE_HINT = "\n\n(The user instruction is written in English.)"


def enhancer_graph(prompt: str, image_names: list[str], seed: int) -> dict[str, Any]:
    kind = "i2i" if image_names else "t2i"
    system = (config.PROMPTS_DIR / f"pe_{kind}.txt").read_text().strip()
    g: dict[str, Any] = {
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": config.ENHANCER[kind], "type": "stable_diffusion", "device": "default"}},
        "sys": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": system}},
        "gen": {"class_type": "TextGenerate", "inputs": {
            "clip": ["clip", 0], "prompt": prompt + (I2I_LANGUAGE_HINT if image_names else ""), "max_length": 4096,
            "sampling_mode": "on", "sampling_mode.temperature": 1.0, "sampling_mode.top_k": 20,
            "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0.0, "sampling_mode.repetition_penalty": 1.0,
            "sampling_mode.seed": seed, "thinking": False, "use_default_template": True, "system_prompt": ["sys", 0]}},
        ENHANCER_OUTPUT_NODE: {"class_type": "PreviewAny", "inputs": {"source": ["gen", 0]}},
    }
    previous: list[Any] | None = None
    for i, name in enumerate(image_names, 1):
        g[f"load{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        g[f"fit{i}"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": [f"load{i}", 0], "upscale_method": "lanczos", "megapixels": 0.6, "resolution_steps": 32}}
        if previous is None:
            previous = [f"fit{i}", 0]
        else:
            g[f"batch{i}"] = {"class_type": "ImageBatch", "inputs": {"image1": previous, "image2": [f"fit{i}", 0]}}
            previous = [f"batch{i}", 0]
    if previous:
        g["gen"]["inputs"]["image"] = previous
    return g


def nearest_aspect(ratio: str) -> str | None:
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$", ratio or "")
    if not m or float(m.group(2)) == 0:
        return None
    target = math.log(float(m.group(1)) / float(m.group(2)))
    return min(ASPECTS, key=lambda a: abs(math.log(int(a.split(":")[0]) / int(a.split(":")[1])) - target))


def parse_enhancer(text: str) -> tuple[str, str | None, int | None]:
    """The enhancer answers with one JSON object: rewritten_prompt, wh_ratio, and (I2I) ratio_follow.

    Returns the prompt, the suggested aspect, and which input image (1-based) the output should follow, if any.
    """
    body = re.sub(r"```(?:json)?", "", text)
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the answer")
    data = json.loads(body[start:end + 1])
    prompt = str(data.get("rewritten_prompt") or "").strip()
    if not prompt:
        raise ValueError("the answer has no rewritten_prompt")
    follow_raw = str(data.get("ratio_follow") or "").strip()
    if follow_raw:  # e.g. "<image2>"; a follow without a number means image 1
        number = re.search(r"\d+", follow_raw)
        return prompt, None, int(number.group()) if number else 1
    return prompt, nearest_aspect(str(data.get("wh_ratio") or "")), None
