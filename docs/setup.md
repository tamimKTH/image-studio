# Setup

This guide installs Image Studio on a Mac, from a fresh clone to the first image. It also covers updating, uninstalling and fixing common problems.

An AI coding agent can do these steps for you. The [README](../README.md#install-with-an-ai-coding-agent) has the prompt to give it.

## What you need

| | Requirement |
|---|---|
| **Mac** | Apple silicon. Setup stops if PyTorch can't use the Apple GPU (MPS). Built and tested on an M5 Max. |
| **Memory** | 64 GB or more is a sensible minimum. The engine used 38 GB while generating on an M5 Max with 128 GB, and the prompt enhancer loads another 19 GB of weights. |
| **Disk** | About 95 GB for the models, plus 1.5 GB for the engine. |
| **Software** | [Docker Desktop](https://www.docker.com/products/docker-desktop/), [uv](https://docs.astral.sh/uv/) (`brew install uv`), and `git`. `uv` installs the engine's Python 3.13 by itself. |

## 1. Get the code

```sh
git clone https://github.com/tamimKTH/image-studio.git
cd image-studio
```

## 2. Download the models

Image Studio reads its models from `~/ComfyUI-Shared/models`.

| File | Folder | Size | Source |
|---|---|---|---|
| `qwen-image-2.1-UC-Q8_0.gguf` | `diffusion_models/` | 7.6 GB | [abenzerps/Qwen-Image-2.1-Uncensored-GGUF](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF) |
| `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 0.7 GB | [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) |
| `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 9.4 GB | Comfy-Org/Qwen-Image-2.1 |
| `qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors` | `text_encoders/` | 9.5 GB | Comfy-Org/Qwen-Image-2.1 |
| `qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors` | `text_encoders/` | 9.5 GB | Comfy-Org/Qwen-Image-2.1 |

The two `pe` files are the prompt enhancers behind **Improve**. The app generates images without them, but Improve and Auto-improve need them.

To download all five files with the Hugging Face CLI, run:

```sh
M=~/ComfyUI-Shared/models

uvx --from huggingface_hub hf download abenzerps/Qwen-Image-2.1-Uncensored-GGUF \
	qwen-image-2.1-UC-Q8_0.gguf --local-dir "$M/diffusion_models"

uvx --from huggingface_hub hf download Comfy-Org/Qwen-Image-2.1 \
	vae/qwen_image_2.1_vae_bf16.safetensors \
	text_encoders/qwen3vl_8b_int8_convrot.safetensors \
	text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors \
	text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors \
	--local-dir "$M"
```

The model weights are under the Qwen Research License, which allows non-commercial research use only. Read it on the [Qwen-Image-2.1 model page](https://huggingface.co/Qwen/Qwen-Image-2.1) before you download.

## 3. Install and start

Start Docker Desktop, then run:

```sh
./studio setup
```

`setup` does the following, and it is safe to run again:

1. Checks that Docker is installed.
2. Installs ComfyUI v0.37.4, ComfyUI-GGUF and PyTorch 2.10 into `~/Library/Application Support/ImageStudio/engine`, and checks that PyTorch can use the Apple GPU.
3. Converts the three int8 text encoders to bf16 copies (`*.dequant-bf16.safetensors`, about 55 GB together). The Apple GPU can't run the int8 files. See [why](architecture.md#why-the-engine-runs-outside-docker).
4. Creates `~/Pictures/Image Studio`.
5. Installs the engine as a login service (`~/Library/LaunchAgents/com.majed.imagestudio.engine.plist`) and starts it.
6. Builds and starts the Docker container.

When it finishes, it prints `Image Studio is running: http://127.0.0.1:4747`. Open that address.

After setup, the three int8 files are no longer needed, and you can delete them to free 28 GB. Keep the bf16 copies. `setup` can make a missing copy again only while its int8 file is still there.

## 4. Make your first image

Type a prompt on the **Create** screen and press **Generate**. Watch the step counter. A 1K image at Standard quality took 85 to 100 seconds on an M5 Max. When the models aren't loaded, the engine loads them first, which took about 20 seconds more.

The [product guide](product.md) shows everything else the app can do.

## Everyday commands

| Command | What it does |
|---|---|
| `./studio setup` | First install, or repair. Safe to run again. |
| `./studio start` | Starts the engine and the app. Rebuilds the app image first. |
| `./studio stop` | Stops both |
| `./studio status` | Shows whether the engine is online and the app is running |
| `./studio logs` | Follows the engine and app logs |
| `./studio open` | Opens the app in your browser |

The engine starts by itself when you log in. Docker restarts the app when Docker Desktop starts, unless you stopped it with `./studio stop`.

## Update

```sh
git pull
./studio start
```

`start` rebuilds the app image, so the new code runs straight away. Wait until Activity shows no running work first. A run that is active during a rebuild ends with "Interrupted by an app restart", and **Retry** resumes it.

If an update changes the engine's flags in `studio`, run `./studio setup` instead of `start`, because only `setup` rewrites the login service.

`./studio setup` doesn't replace a ComfyUI install that already exists. To install a new engine version after a change to `engine/setup.sh`, run `./studio stop`, delete `~/Library/Application Support/ImageStudio/engine`, and run `./studio setup`.

## Uninstall

The following commands remove the app, the engine and the app's data. Your images and the model files stay where they are.

```sh
./studio stop
rm ~/Library/LaunchAgents/com.majed.imagestudio.engine.plist
docker compose down --rmi all
rm -rf ~/Library/Application\ Support/ImageStudio
```

The last command also empties the app's trash of deleted images. To remove the models too, delete the files listed in [step 2](#2-download-the-models) and the three `*.dequant-bf16.safetensors` copies in `~/ComfyUI-Shared/models/text_encoders`.

## Troubleshooting

| Problem | What to do |
|---|---|
| The dot at the bottom of the left rail is red | The engine or the app is offline. Run `./studio status`, then `./studio start`. Click the dot to see which model files the app found. |
| `setup` says `uv is required` | Run `brew install uv`. |
| `setup` says `Docker Desktop is required` | Install Docker Desktop and start it. |
| `setup` says `Apple GPU (MPS) not available` | The engine needs an Apple silicon Mac. |
| `setup` says `Missing .../qwen-image-2.1-UC-Q8_0.gguf` | Download the models ([step 2](#2-download-the-models)). |
| `The engine did not start; see ./studio logs` | Run `./studio logs`. The engine's own log is `~/Library/Application Support/ImageStudio/logs/engine.log`. |
| The page says "Open Image Studio at http://127.0.0.1:4747" | The app answers only on local addresses. Open `http://127.0.0.1:4747` or `http://localhost:4747`. |
| A run says "Interrupted by an app restart" or "The engine restarted while this was running" | Press **Retry**. Steps that had finished are reused. |
| The first image after a break is slow | After 10 idle minutes the app unloads the models to free memory. The next image loads them again, which took about 20 seconds on an M5 Max. |
| You deleted an image by mistake | Press **Undo** on the notice. Within 30 days you can also copy it back from `~/Library/Application Support/ImageStudio/trash`. |
