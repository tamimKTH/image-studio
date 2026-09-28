#!/bin/bash
# Installs the local image engine (ComfyUI + the GGUF loader) into the runtime
# folder. The engine runs natively because Docker on a Mac cannot reach the GPU.
set -euo pipefail

RUNTIME_DIR="${STUDIO_RUNTIME_DIR:-$HOME/Library/Application Support/ImageStudio}"
ENGINE_DIR="$RUNTIME_DIR/engine"
COMFY_REPO="https://github.com/Comfy-Org/ComfyUI.git"
COMFY_TAG="v0.37.4"
GGUF_REPO="https://github.com/leejet/ComfyUI-GGUF.git"
GGUF_COMMIT="373048b8403a7820620065210a691263d4da0a61"
TORCH_PACKAGES="torch==2.10.0 torchvision==0.25.0 torchaudio==2.10.0"

command -v uv >/dev/null || { echo "uv is required: brew install uv" >&2; exit 1; }
mkdir -p "$ENGINE_DIR"

if [ ! -d "$ENGINE_DIR/ComfyUI/.git" ]; then
  git clone --quiet --depth 1 --branch "$COMFY_TAG" "$COMFY_REPO" "$ENGINE_DIR/ComfyUI"
fi

GGUF_DIR="$ENGINE_DIR/ComfyUI/custom_nodes/ComfyUI-GGUF"
if [ ! -d "$GGUF_DIR/.git" ]; then
  git clone --quiet "$GGUF_REPO" "$GGUF_DIR"
fi
git -C "$GGUF_DIR" checkout --quiet "$GGUF_COMMIT"

PYTHON="$ENGINE_DIR/.venv/bin/python"
[ -x "$PYTHON" ] || uv venv --quiet --python 3.13 "$ENGINE_DIR/.venv"
# shellcheck disable=SC2086
uv pip install --quiet --python "$PYTHON" $TORCH_PACKAGES
uv pip install --quiet --python "$PYTHON" \
  -r "$ENGINE_DIR/ComfyUI/requirements.txt" -r "$GGUF_DIR/requirements.txt"

"$PYTHON" -c 'import torch; assert torch.backends.mps.is_available(), "Apple GPU (MPS) not available"'
echo "Engine installed in $ENGINE_DIR"
