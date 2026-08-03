from pathlib import Path

COMFY_ROOT = Path(r"E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI")


def _scan(rel_dir):
    target = COMFY_ROOT / "models" / rel_dir
    if not target.exists():
        return {"exists": False, "files": []}
    files = [
        f.name
        for f in target.iterdir()
        if f.is_file() and f.stat().st_size > 0
    ]
    return {"exists": True, "files": sorted(files)}


def survey():
    custom_nodes = [
        p.name
        for p in (COMFY_ROOT / "custom_nodes").iterdir()
        if p.is_dir()
    ]
    ipadapter = _scan("ipadapter")
    clip_vision = _scan("clip_vision")
    controlnet = _scan("controlnet")
    loras = _scan("loras")
    photomaker = _scan("photomaker")
    has_ipadapter_node = any(
        "ipadapter" in name.lower() for name in custom_nodes
    )
    ipadapter_available = (
        bool(ipadapter.get("files")) and has_ipadapter_node
    )
    missing = []
    if not ipadapter.get("files"):
        missing.extend(
            [
                "models/ipadapter/ip-adapter-plus_sd15.safetensors",
                "models/ipadapter/ip-adapter-faceid-plusv2_sd15.bin",
            ]
        )
    if not clip_vision.get("files"):
        missing.append(
            "models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
        )
    if not has_ipadapter_node:
        missing.append("custom_nodes/ComfyUI_IPAdapter_plus")
    return {
        "comfy_root": str(COMFY_ROOT),
        "ipadapter_available": ipadapter_available,
        "ipadapter": ipadapter,
        "clip_vision": clip_vision,
        "controlnet": controlnet,
        "loras": loras,
        "photomaker": photomaker,
        "custom_nodes": sorted(custom_nodes),
        "missing": missing,
        "action": "not_downloaded; manual placement required",
    }
