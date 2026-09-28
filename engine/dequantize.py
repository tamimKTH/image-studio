"""Convert a ComfyUI int8 (convrot) text encoder to plain bf16.

PyTorch has no int8 matmul (aten::_int_mm) on the Apple GPU, so the int8 files
can only run on the CPU, where a 9B prompt enhancer produces seconds per token.
The bf16 copy runs on the GPU. Usage: python dequantize.py SRC.safetensors DST.safetensors
"""
import json
import sys

import torch
from comfy_kitchen.tensor.int8 import TensorWiseINT8Layout
from safetensors import safe_open
from safetensors.torch import save_file


def dequantize(src: str, dst: str) -> None:
    out = {}
    with safe_open(src, "pt") as f:
        keys = set(f.keys())
        for key in sorted(keys):
            if key.endswith((".comfy_quant", ".weight_scale")):
                continue
            tensor = f.get_tensor(key)
            base = key[: -len(".weight")] if key.endswith(".weight") else None
            if base and f"{base}.comfy_quant" in keys:
                conf = json.loads(bytes(f.get_tensor(f"{base}.comfy_quant").tolist()))
                if conf.get("format") != "int8_tensorwise":
                    raise SystemExit(f"{key}: unsupported format {conf.get('format')}")
                params = TensorWiseINT8Layout.Params(
                    scale=f.get_tensor(f"{base}.weight_scale"),
                    orig_dtype=torch.bfloat16,
                    orig_shape=tuple(tensor.shape),
                    convrot=conf.get("convrot", False),
                    convrot_groupsize=conf.get("convrot_groupsize", 256),
                )
                tensor = TensorWiseINT8Layout.dequantize(tensor, params)
            out[key] = tensor.to(torch.bfloat16) if tensor.is_floating_point() else tensor
    save_file(out, dst)


if __name__ == "__main__":
    dequantize(sys.argv[1], sys.argv[2])
