import json
import shutil
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]

DEFAULT_ASSET_MAP = {
    "char_001": {
        "front_face": "output/reference/20260731_171708/char_001.png",
        "side_face": "output/v2_images/20260731_171708/shot_014.png",
        "full_body": "output/v2_images/20260731_171708/shot_004.png",
        "expression": "output/v2_images/20260731_171708/shot_006.png",
        "outfit": "output/v2_images/20260731_171708/shot_001.png",
    },
    "char_002": {
        "front_face": "output/reference/20260731_171708/char_002.png",
        "side_face": "output/v2_images/20260731_171708/shot_008.png",
        "full_body": "output/v2_images/20260731_171708/shot_001.png",
        "expression": "output/v2_images/20260731_171708/shot_009.png",
        "outfit": "output/v2_images/20260731_171708/shot_002.png",
    },
    "char_003": {
        "front_face": "output/reference/20260731_171708/char_003.png",
        "side_face": "output/v2_images/20260731_171708/shot_010.png",
        "full_body": "output/v2_images/20260731_171708/shot_004.png",
        "expression": "output/v2_images/20260731_171708/shot_005.png",
        "outfit": "output/v2_images/20260731_171708/shot_004.png",
    },
    "char_004": {
        "front_face": "output/reference/20260731_171708/char_004.png",
        "side_face": "output/v2_images/20260731_171708/shot_015.png",
        "full_body": "output/v2_images/20260731_171708/shot_012.png",
        "expression": "output/v2_images/20260731_171708/shot_016.png",
        "outfit": "output/v2_images/20260731_171708/shot_013.png",
    },
}

DEFAULT_MARKERS_EN = {
    "char_001": "small mole below left eye, red hair tie on ponytail",
    "char_002": "mole on left cheek, silver bracelet on wrist",
    "char_003": "gold-rimmed glasses, red handkerchief in left chest pocket",
    "char_004": "scar above right eyebrow, silver earring on left ear",
}

DEFAULT_ANCHORS = {
    "char_001": {
        "face_shape": "oval delicate face",
        "skin_tone": "fair skin",
        "body_shape": "slender average-height body",
        "hair_accessory": "red hair tie",
    },
    "char_002": {
        "face_shape": "round kind face",
        "skin_tone": "warm tan skin",
        "body_shape": "average middle-aged body",
        "hair_accessory": "none",
    },
    "char_003": {
        "face_shape": "square mature face",
        "skin_tone": "medium skin",
        "body_shape": "tall lean body",
        "hair_accessory": "none",
    },
    "char_004": {
        "face_shape": "angular sharp face",
        "skin_tone": "fair skin",
        "body_shape": "slim tall body",
        "hair_accessory": "silver earring",
    },
}


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_run_characters(run_id):
    return _load_json(
        PROJECT_DIR / "data" / "runs" / run_id / "v2" / "characters.json"
    )


def get_character_card(character_id, characters_root=None):
    root = (
        Path(characters_root)
        if characters_root
        else PROJECT_DIR / "data" / "characters"
    )
    path = root / character_id / "character_card.json"
    card = _load_json(path)
    if not card:
        raise FileNotFoundError(f"character card not found: {path}")
    return card


def build_character_asset(
    character_id,
    run_id="20260731_171708",
    asset_map=None,
    characters_root=None,
):
    root = (
        Path(characters_root)
        if characters_root
        else PROJECT_DIR / "data" / "characters"
    )
    char_dir = root / character_id
    asset_map = asset_map or DEFAULT_ASSET_MAP.get(character_id, {})
    if not asset_map:
        raise ValueError(f"no asset map for character: {character_id}")

    characters = load_run_characters(run_id) or {}
    card_raw = next(
        (
            c
            for c in characters.get("characters", [])
            if c.get("character_id") == character_id
        ),
        None,
    )
    if not card_raw:
        raise ValueError(
            f"character {character_id} not found in run {run_id} characters.json"
        )

    card = dict(card_raw)
    card["source_run_id"] = run_id
    card["distinctive_marker_en"] = DEFAULT_MARKERS_EN.get(
        character_id, card_raw.get("distinctive_marker", "")
    )
    anchor_defaults = DEFAULT_ANCHORS.get(character_id, {})
    card["appearance_anchor"] = {
        "eye_color": (card_raw.get("eye_color") or "").strip(),
        "hair_style": (card_raw.get("hair_style") or "").strip(),
        "hair_accessory": anchor_defaults.get("hair_accessory", "none"),
        "face_shape": anchor_defaults.get("face_shape", "natural face"),
        "skin_tone": anchor_defaults.get("skin_tone", "natural skin tone"),
        "body_shape": anchor_defaults.get("body_shape", "natural body"),
    }
    anchor = card["appearance_anchor"]
    card["identity_tags_en"] = ", ".join(
        part
        for part in (
            card_raw.get("appearance_en", ""),
            card["distinctive_marker_en"],
            anchor["face_shape"],
            anchor["skin_tone"],
            anchor["body_shape"],
            anchor["hair_accessory"] if anchor["hair_accessory"] != "none" else "",
            card_raw.get("style_tags", ""),
        )
        if part
    )

    char_dir.mkdir(parents=True, exist_ok=True)
    asset_paths = {}
    reference_sources = []
    for asset_name, rel_source in asset_map.items():
        source = PROJECT_DIR / rel_source
        if not source.exists():
            raise FileNotFoundError(
                f"asset source not found for {character_id}/{asset_name}: {source}"
            )
        target = char_dir / f"{asset_name}.png"
        if not target.exists():
            shutil.copy2(source, target)
        asset_paths[asset_name] = str(target)
        reference_sources.append(
            {"asset": asset_name, "source": str(source), "note": asset_name}
        )

    card["asset_paths"] = asset_paths
    card["reference_sources"] = reference_sources
    card["created_at"] = datetime.now().isoformat(timespec="seconds")
    _save_json(char_dir / "character_card.json", card)
    return card
