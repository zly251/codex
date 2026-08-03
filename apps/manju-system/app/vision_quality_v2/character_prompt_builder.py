import json
import re
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]

DEFAULT_NEGATIVE = (
    "deformed, extra hands, blurry, text, watermark, low quality, "
    "bad anatomy, unnatural face, inconsistent features, duplicate, cropped"
)

IDENTITY_LOCK = "same person, identical facial features, identical hairstyle, identical eye color"


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _clean_comma(text):
    text = re.sub(r"\s*,\s*,\s*", ", ", text or "")
    return text.strip(" ,")


class CharacterPromptBuilder:
    """Builds prompts from character_card without letting an LLM invent appearance."""

    def __init__(self, run_id="20260731_171708"):
        self.run_id = run_id
        self.characters = self._load_characters()

    def _load_characters(self):
        data = _load_json(PROJECT_DIR / "data" / "runs" / self.run_id / "v2" / "characters.json")
        return (data or {}).get("characters", [])

    def _identity_phrases(self, card):
        phrases = [
            card.get("appearance_en"),
            card.get("clothing_en"),
            card.get("distinctive_marker_en"),
            card.get("style_tags"),
        ]
        return [p.strip() for p in phrases if p and p.strip()]

    def _identity_tags(self, card):
        appearance = (card.get("appearance_en") or "").strip()
        clothing = (card.get("clothing_en") or "").strip()
        if clothing and clothing in appearance:
            appearance = appearance.replace(clothing, "").replace(",,", ",").strip(" ,")
        anchor = card.get("appearance_anchor") or {}
        parts = [
            appearance,
            (card.get("distinctive_marker_en") or "").strip(),
            str(anchor.get("face_shape") or "").strip(),
            str(anchor.get("skin_tone") or "").strip(),
            str(anchor.get("body_shape") or "").strip(),
            str(anchor.get("hair_accessory") or "").strip()
            if str(anchor.get("hair_accessory") or "").strip() != "none"
            else "",
            (card.get("style_tags") or "").strip(),
        ]
        return _clean_comma(", ".join(p for p in parts if p))

    def _strip_identity(self, positive, card):
        text = positive or ""
        for phrase in self._identity_phrases(card):
            text = text.replace(phrase + ",", "")
            text = text.replace(phrase, "")
        return _clean_comma(text)

    def build(self, card, shot):
        scene_tail = self._strip_identity(shot.get("positive", ""), card)
        identity = self._identity_tags(card)
        positive = _clean_comma(f"{identity}, {scene_tail}, {IDENTITY_LOCK}")
        negative = shot.get("negative") or DEFAULT_NEGATIVE
        negative = _clean_comma(
            f"{negative}, different face, inconsistent identity, "
            "changed hairstyle, changed eye color, changed clothes"
        )
        return {
            "shot_id": shot.get("shot_id"),
            "character_id": card.get("character_id"),
            "positive": positive,
            "negative": negative,
            "identity_source": "character_card",
            "identity_lock": IDENTITY_LOCK,
            "scene_tail": scene_tail,
        }
