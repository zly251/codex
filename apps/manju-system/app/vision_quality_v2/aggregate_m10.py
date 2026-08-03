import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))


def _load(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    run_id = "20260731_171708"
    base = PROJECT_DIR / "data" / "vision_quality_v2" / run_id
    characters = []
    for character_id in ("char_001", "char_002", "char_003", "char_004"):
        char_dir = base / character_id
        report_dir = char_dir if (char_dir / "run_summary.json").exists() else base
        card = _load(PROJECT_DIR / "data" / "characters" / character_id / "character_card.json")
        consistency = _load(report_dir / "character_consistency_report.json") or {}
        quality = _load(report_dir / "quality_judge_report.json") or []
        done = [e for e in quality if isinstance(e, dict) and e.get("status") == "done"]
        characters.append(
            {
                "character_id": character_id,
                "name": (card or {}).get("name"),
                "asset_dir": f"data/characters/{character_id}",
                "scene_count": len(consistency.get("scenes", [])),
                "consistency": {
                    "status": consistency.get("status"),
                    "character_identity": consistency.get("character_identity"),
                    "scene_realism": consistency.get("scene_realism"),
                    "ai_artifact": consistency.get("ai_artifact"),
                    "human_acceptance_probability": consistency.get("human_acceptance_probability"),
                    "conclusion": consistency.get("conclusion"),
                },
                "quality_judge": {
                    "done_count": len(done),
                    "failed_count": len(quality) - len(done),
                    "avg_character_identity": round(
                        sum(e.get("character_identity", 0) for e in done) / len(done), 1
                    )
                    if done
                    else None,
                    "avg_human_acceptance_probability": round(
                        sum(e.get("human_acceptance_probability", 0) for e in done) / len(done),
                        1,
                    )
                    if done
                    else None,
                },
                "report_dir": str(report_dir),
            }
        )

    identities = [
        c["consistency"]["character_identity"]
        for c in characters
        if c["consistency"].get("character_identity") is not None
    ]
    acceptance = [
        c["quality_judge"]["avg_human_acceptance_probability"]
        for c in characters
        if c["quality_judge"].get("avg_human_acceptance_probability") is not None
    ]
    result = {
        "run_id": run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "characters": characters,
        "overall": {
            "avg_character_identity": round(sum(identities) / len(identities), 1)
            if identities
            else None,
            "avg_human_acceptance_probability": round(sum(acceptance) / len(acceptance), 1)
            if acceptance
            else None,
        },
        "ipadapter": {
            "available": False,
            "missing": [
                "models/ipadapter/ip-adapter-plus_sd15.safetensors",
                "models/ipadapter/ip-adapter-faceid-plusv2_sd15.bin",
                "models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
                "custom_nodes/ComfyUI_IPAdapter_plus",
            ],
        },
    }
    target = base / "m10_summary.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
