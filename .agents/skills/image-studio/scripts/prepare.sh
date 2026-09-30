#!/bin/bash
# Helps an AI agent install Image Studio. Changes nothing unless you run `download`.
#   bash prepare.sh check              report the Mac, the software, the models and what is installed
#   bash prepare.sh download           download the model files that are missing (about 37 GB when all are)
#   bash prepare.sh download --dry-run print the download commands without running them
# The model list matches docs/setup.md, section "2. Download the models". Keep the two in sync.
set -uo pipefail

MODELS_DIR="${STUDIO_MODELS_DIR:-$HOME/ComfyUI-Shared/models}"
RUNTIME_DIR="${STUDIO_RUNTIME_DIR:-$HOME/Library/Application Support/ImageStudio}"
PLIST="$HOME/Library/LaunchAgents/com.majed.imagestudio.engine.plist"
GGUF_REPO="abenzerps/Qwen-Image-2.1-Uncensored-GGUF"
COMFY_REPO="Comfy-Org/Qwen-Image-2.1"

# path in the models folder | download size in GB | bf16 copy that setup makes from it | copy size in GB
MODELS="diffusion_models/qwen-image-2.1-UC-Q8_0.gguf|7.6||
vae/qwen_image_2.1_vae_bf16.safetensors|0.7||
text_encoders/qwen3vl_8b_int8_convrot.safetensors|9.4|text_encoders/qwen3vl_8b.dequant-bf16.safetensors|17.5
text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors|9.5|text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.dequant-bf16.safetensors|18.8
text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors|9.5|text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.dequant-bf16.safetensors|18.8"

# Prints the model files that must be downloaded. An int8 file whose bf16 copy exists is not needed.
missing_models() {
  local file size copy copy_size
  while IFS='|' read -r file size copy copy_size; do
    [ -f "$MODELS_DIR/$file" ] && continue
    [ -n "$copy" ] && [ -f "$MODELS_DIR/$copy" ] && continue
    echo "$file"
  done <<< "$MODELS"
}

check() {
  local blockers=() file size copy copy_size download=0 copies=0 engine_gb=0
  printf 'Mac\n'
  local arch mem_gb free_gb disk_dir
  arch="$(uname -m)"
  if [ "$arch" = arm64 ]; then printf '  chip       arm64, ok\n'
  else printf '  chip       %s, NOT SUPPORTED (needs Apple silicon)\n' "$arch"; blockers+=("not an Apple silicon Mac"); fi
  mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if [ "$mem_gb" -ge 64 ]; then printf '  memory     %s GB, ok\n' "$mem_gb"
  else printf '  memory     %s GB, BELOW the 64 GB the docs call a sensible minimum\n' "$mem_gb"; fi
  disk_dir="$MODELS_DIR"; while [ ! -d "$disk_dir" ]; do disk_dir="$(dirname "$disk_dir")"; done
  free_gb=$(( $(df -Pk "$disk_dir" | awk 'NR==2 {print $4}') / 1048576 ))
  printf '  free disk  %s GB\n' "$free_gb"

  printf 'Software\n'
  if command -v brew >/dev/null; then printf '  Homebrew   installed\n'; else printf '  Homebrew   missing (optional, used to install uv)\n'; fi
  if command -v git >/dev/null; then printf '  git        installed\n'
  else printf '  git        MISSING: the user runs `xcode-select --install`\n'; blockers+=("git is missing"); fi
  if command -v uv >/dev/null; then printf '  uv         installed\n'
  else printf '  uv         MISSING: `brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`\n'; blockers+=("uv is missing"); fi
  if docker info >/dev/null 2>&1; then printf '  Docker     installed and running\n'
  elif [ -d /Applications/Docker.app ] || command -v docker >/dev/null; then
    printf '  Docker     installed, NOT RUNNING: `open -a Docker`, then wait until `docker info` succeeds\n'; blockers+=("Docker Desktop is not running")
  else
    printf '  Docker     MISSING: the user installs Docker Desktop from https://www.docker.com/products/docker-desktop/ and opens it once\n'; blockers+=("Docker Desktop is missing")
  fi

  printf 'Models in %s\n' "$MODELS_DIR"
  while IFS='|' read -r file size copy copy_size; do
    if [ -f "$MODELS_DIR/$file" ]; then printf '  ok       %s\n' "$file"
    elif [ -n "$copy" ] && [ -f "$MODELS_DIR/$copy" ]; then printf '  ok       %s (its bf16 copy exists)\n' "$file"
    else printf '  MISSING  %s (%s GB)\n' "$file" "$size"; download=$(echo "$download + $size" | bc); fi
    if [ -n "$copy" ] && [ ! -f "$MODELS_DIR/$copy" ]; then copies=$(echo "$copies + $copy_size" | bc); fi
  done <<< "$MODELS"

  printf 'Image Studio\n'
  if [ -f "$PLIST" ] && [ -x "$RUNTIME_DIR/engine/.venv/bin/python" ]; then printf '  engine     installed\n'
  else printf '  engine     not installed\n'; engine_gb=1.5; fi
  if curl -fs -o /dev/null http://127.0.0.1:8199/system_stats; then printf '  engine     online\n'; else printf '  engine     offline\n'; fi
  if curl -fs -o /dev/null http://127.0.0.1:4747/api/status; then printf '  app        running at http://127.0.0.1:4747\n'; else printf '  app        not running\n'; fi

  local need
  need=$(echo "$download + $copies + $engine_gb" | bc)
  printf 'Summary\n'
  printf '  download   %s GB of models\n' "$download"
  printf '  disk       about %s GB needed (downloads, bf16 copies that setup makes, engine), %s GB free\n' "$need" "$free_gb"
  if [ "$(echo "$need > $free_gb" | bc)" = 1 ]; then blockers+=("not enough free disk space"); fi
  if [ ${#blockers[@]} -eq 0 ]; then printf '  blockers   none\n'
  else printf '  BLOCKER    %s\n' "${blockers[@]}"; fi
}

download() {
  local dry=false gguf=() comfy=() file
  [ "${1:-}" = "--dry-run" ] && dry=true
  command -v uv >/dev/null || { echo "uv is required: brew install uv" >&2; exit 1; }
  while read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      diffusion_models/*) gguf+=("${file#diffusion_models/}") ;;
      *) comfy+=("$file") ;;
    esac
  done <<< "$(missing_models)"
  if [ ${#gguf[@]} -eq 0 ] && [ ${#comfy[@]} -eq 0 ]; then echo "All model files are present."; exit 0; fi

  # Progress bars fill a log with carriage returns. Check progress with `du -sh` on the models folder instead.
  export HF_HUB_DISABLE_PROGRESS_BARS=1
  local run=(uvx --from huggingface_hub hf download)
  if [ ${#gguf[@]} -gt 0 ]; then
    echo "Downloading ${gguf[*]} from $GGUF_REPO"
    if $dry; then echo "${run[*]} $GGUF_REPO ${gguf[*]} --local-dir $MODELS_DIR/diffusion_models"
    else "${run[@]}" "$GGUF_REPO" "${gguf[@]}" --local-dir "$MODELS_DIR/diffusion_models" || { echo "Download failed."; exit 1; }; fi
  fi
  if [ ${#comfy[@]} -gt 0 ]; then
    echo "Downloading ${comfy[*]} from $COMFY_REPO"
    if $dry; then echo "${run[*]} $COMFY_REPO ${comfy[*]} --local-dir $MODELS_DIR"
    else "${run[@]}" "$COMFY_REPO" "${comfy[@]}" --local-dir "$MODELS_DIR" || { echo "Download failed."; exit 1; }; fi
  fi
  $dry || echo "Download finished."
}

case "${1:-}" in
  check) check ;;
  download) download "${2:-}" ;;
  *) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
