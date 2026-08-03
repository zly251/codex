import argparse
import json
import os
from pathlib import Path


def ensure_model(model_path, hf_mirror):
    model_path = Path(model_path)
    if (model_path / "config.json").exists():
        return str(model_path)
    os.environ["HF_ENDPOINT"] = hf_mirror or "https://huggingface.co"
    from huggingface_hub import snapshot_download

    snapshot_download("openai/clip-vit-base-patch32", local_dir=str(model_path))
    return str(model_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--scene-text", required=True)
    parser.add_argument("--character-text", required=True)
    parser.add_argument("--reference-image")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--hf-mirror", default="")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    args = parser.parse_args()

    import torch
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor

    model_dir = ensure_model(args.model_path, args.hf_mirror)
    # 默认 CPU：避免与 ComfyUI 争抢 4GB 显存
    device = args.device if args.device == "cuda" and torch.cuda.is_available() else "cpu"
    model = CLIPModel.from_pretrained(model_dir, use_safetensors=False).to(device).eval()
    processor = CLIPProcessor.from_pretrained(model_dir)

    def encode_image(path):
        image = Image.open(path).convert("RGB")
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            return model.get_image_features(**inputs).pooler_output

    with torch.no_grad():
        text_inputs = processor(
            text=[args.scene_text, args.character_text],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=77,
        ).to(device)
        text_features = model.get_text_features(**text_inputs).pooler_output
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)

        image_feature = encode_image(args.image)
        image_feature = image_feature / image_feature.norm(dim=-1, keepdim=True)
        scene_sim = float((image_feature @ text_features[0:1].T).item())
        character_text_sim = float((image_feature @ text_features[1:2].T).item())
        reference_sim = None
        if args.reference_image:
            ref_feature = encode_image(args.reference_image)
            ref_feature = ref_feature / ref_feature.norm(dim=-1, keepdim=True)
            reference_sim = float((image_feature @ ref_feature.T).item())

    print(
        json.dumps(
            {
                "scene_sim": scene_sim,
                "character_text_sim": character_text_sim,
                "reference_sim": reference_sim,
            }
        )
    )


if __name__ == "__main__":
    main()
