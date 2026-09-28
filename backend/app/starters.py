"""Starter workflows offered by New workflow."""

DEFAULT_ADVANCED = {"seed": None, "negative": "", "cfg": None, "steps": None,
                    "sampler": "euler", "scheduler": "simple", "refDetail": "standard"}
STEP = 340


def generate_data(prompt: str, inputs: list[str]) -> dict:
    return {"prompt": prompt, "inputs": inputs, "aspect": "auto", "size": "1k", "quality": "standard", "count": 1,
            "transparent": False, "autoImprove": False, "folder": None, "advanced": dict(DEFAULT_ADVANCED)}


def _image(node_id: str, x: int, y: int) -> dict:
    return {"id": node_id, "type": "image", "position": {"x": x, "y": y}, "data": {"asset": None}}


def _edge(source: str, target: str) -> dict:
    return {"id": f"e-{source}-{target}", "source": source, "target": target}


STARTERS = {
    "blank": ("Untitled workflow", lambda: {
        "nodes": [_image("i1", 0, 0),
                  {"id": "g1", "type": "generate", "position": {"x": STEP, "y": 0}, "data": generate_data("", ["i1"])}],
        "edges": [_edge("i1", "g1")]}),
    "combine": ("Combine two images", lambda: {
        "nodes": [_image("i1", 0, -120), _image("i2", 0, 120),
                  {"id": "g1", "type": "generate", "position": {"x": STEP, "y": 0},
                   "data": generate_data("Put image 2 into image 1, matching the lighting", ["i1", "i2"])}],
        "edges": [_edge("i1", "g1"), _edge("i2", "g1")]}),
    "cutout": ("Cut out and restage", lambda: {
        "nodes": [_image("i1", 0, 0),
                  {"id": "r1", "type": "removeBackground", "position": {"x": STEP, "y": 0}, "data": {"folder": None}},
                  {"id": "g1", "type": "generate", "position": {"x": STEP * 2, "y": 0},
                   "data": generate_data("Place the subject from image 1 on a clean studio backdrop with soft shadows", ["r1"])}],
        "edges": [_edge("i1", "r1"), _edge("r1", "g1")]}),
}


def build(starter: str) -> tuple[str, dict]:
    name, make = STARTERS.get(starter, STARTERS["blank"])
    return name, make()
