import time
import uuid
from pathlib import Path

import httpx

from app.utils.errors import ComfyOfflineError, ModelNotFoundError


class ComfyClient:
    def __init__(self, base_url, checkpoint, output_dir, timeout_seconds=900, logger=None):
        self.base_url = base_url.rstrip("/")
        self.checkpoint = checkpoint
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.timeout_seconds = timeout_seconds
        self.logger = logger
        self.client = httpx.Client(timeout=60)

    def _log(self, level, message):
        if self.logger:
            getattr(self.logger, level)(message)

    def health(self):
        try:
            resp = self.client.get(f"{self.base_url}/system_stats")
            resp.raise_for_status()
            return True
        except Exception as e:
            self._log("warning", f"ComfyUI health check failed: {e}")
            return False

    def check_ready(self, attempts=3, interval=5):
        last_error = None
        for i in range(attempts):
            try:
                resp = self.client.get(f"{self.base_url}/system_stats", timeout=10)
                resp.raise_for_status()
                self._log("info", f"ComfyUI online: {self.base_url}")
                return True
            except Exception as e:
                last_error = e
                self._log("warning", f"ComfyUI 连接失败 ({i + 1}/{attempts}): {e}")
                if i < attempts - 1:
                    time.sleep(interval)
        raise ComfyOfflineError(
            f"ComfyUI 离线或 API 不可访问: {self.base_url}。"
            f"请运行 scripts/start_comfyui.ps1 启动后重试。原始错误: {last_error}"
        )

    def get_checkpoints(self):
        resp = self.client.get(
            f"{self.base_url}/object_info/CheckpointLoaderSimple", timeout=30
        )
        resp.raise_for_status()
        info = resp.json()
        ckpt = (
            info.get("CheckpointLoaderSimple", {})
            .get("input", {})
            .get("required", {})
            .get("ckpt_name")
        )
        if not ckpt or not isinstance(ckpt, list):
            return []
        return [str(name) for name in ckpt[0]] if isinstance(ckpt[0], list) else []

    def ensure_checkpoint(self, checkpoint=None):
        target = checkpoint or self.checkpoint
        available = self.get_checkpoints()
        if target not in available:
            names = ", ".join(available[:20]) if available else "(无可用模型)"
            raise ModelNotFoundError(
                f"模型不存在: {target}。可用模型: {names}。"
                f"请将模型放入 E:\\Comfy-Desktop\\ComfyUI-Shared\\models\\checkpoints"
            )
        self._log("info", f"checkpoint ok: {target}")
        return target

    def build_workflow(self, shot):
        checkpoint = shot.get("checkpoint") or self.checkpoint
        seed = shot.get("seed")
        workflow = {
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": shot["positive"], "clip": ["4", 1]},
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": shot.get("negative", ""), "clip": ["4", 1]},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {
                    "width": shot.get("width", 768),
                    "height": shot.get("height", 1344),
                    "batch_size": 1,
                },
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": shot.get("steps", 20),
                    "cfg": shot.get("cfg", 7.0),
                    "sampler_name": shot.get("sampler", "euler"),
                    "scheduler": shot.get("scheduler", "normal"),
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {
                "class_type": "SaveImage",
                "inputs": {"images": ["8", 0], "filename_prefix": "manju"},
            },
        }
        return workflow

    def generate(self, shot, filename_prefix="manju"):
        client_id = str(uuid.uuid4())
        workflow = self.build_workflow(shot)
        payload = {"prompt": workflow, "client_id": client_id}
        try:
            resp = self.client.post(f"{self.base_url}/prompt", json=payload)
            resp.raise_for_status()
        except Exception as e:
            self._log("error", f"POST /prompt failed: {e}")
            raise
        prompt_id = resp.json().get("prompt_id")
        if not prompt_id:
            self._log("error", "POST /prompt returned no prompt_id: " + resp.text)
            raise RuntimeError("POST /prompt returned no prompt_id")
        self._log("info", f"prompt queued: prompt_id={prompt_id}")

        deadline = time.time() + self.timeout_seconds
        while time.time() < deadline:
            time.sleep(5)
            history = self._get_history(prompt_id)
            if history:
                outputs = history[prompt_id].get("outputs", {})
                images = []
                for node_output in outputs.values():
                    images.extend(node_output.get("images", []))
                if images:
                    image_meta = images[0]
                    image_path = self._download_image(
                        image_meta,
                        target_name=f"{filename_prefix}_{shot['shot_id']}_{image_meta['filename']}",
                    )
                    return {
                        "shot_id": shot["shot_id"],
                        "prompt_id": prompt_id,
                        "seed": shot.get("seed"),
                        "image_path": str(image_path),
                        "filename": image_meta["filename"],
                    }
            status = history.get(prompt_id, {}).get("status", {}) if history else {}
            if status.get("status_str") == "error":
                self._log("error", f"comfy execution error: {status}")
                raise RuntimeError("ComfyUI execution error: " + str(status))
        raise TimeoutError(f"ComfyUI 渲染超时: {self.timeout_seconds}s, prompt_id={prompt_id}")

    def build_workflow_v2(self, shot, v2_cfg):
        checkpoint = shot.get("checkpoint") or v2_cfg.get("checkpoint") or self.checkpoint
        seed = int(shot.get("seed", v2_cfg.get("seed", 0)))
        positive = shot["positive"]
        negative = shot.get("negative", v2_cfg.get("negative", "deformed, extra hands, blurry, text, watermark, low quality"))
        width = int(v2_cfg.get("width", 768))
        height = int(v2_cfg.get("height", 1344))
        steps = int(v2_cfg.get("steps", 24))
        cfg = float(v2_cfg.get("cfg", 7.0))
        sampler = v2_cfg.get("sampler", "euler")
        scheduler = v2_cfg.get("scheduler", "normal")
        hires_scale = float(v2_cfg.get("hires_scale", 1.5))
        hires_steps = int(v2_cfg.get("hires_steps", 20))
        hires_denoise = float(v2_cfg.get("hires_denoise", 0.4))
        workflow = {
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 1]}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 1]}},
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "10": {
                "class_type": "LatentUpscaleBy",
                "inputs": {
                    "samples": ["3", 0],
                    "upscale_method": "nearest-exact",
                    "scale_by": hires_scale,
                },
            },
            "11": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed + 1,
                    "steps": hires_steps,
                    "cfg": cfg,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": hires_denoise,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["10", 0],
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 2]}},
            "9": {
                "class_type": "SaveImage",
                "inputs": {"images": ["8", 0], "filename_prefix": "manju_v2"},
            },
        }
        return workflow

    def build_workflow_v2_detail(self, shot, v2_cfg, image_filename, mask_filename, use_detail=True):
        checkpoint = shot.get("checkpoint") or v2_cfg.get("checkpoint") or self.checkpoint
        seed = int(shot.get("seed", v2_cfg.get("seed", 0)))
        positive = shot["positive"]
        negative = shot.get("negative", v2_cfg.get("negative", "deformed, extra hands, blurry, text, watermark, low quality"))
        sampler = v2_cfg.get("sampler", "euler")
        scheduler = v2_cfg.get("scheduler", "normal")
        face_denoise = float(v2_cfg.get("face_denoise", 0.4))
        face_steps = int(v2_cfg.get("face_steps", 20))
        face_cfg = float(v2_cfg.get("face_cfg", 7.0))
        crop_factor = float(v2_cfg.get("face_crop_factor", 3.0))
        guide_size = float(v2_cfg.get("face_guide_size", 512))
        max_size = float(v2_cfg.get("face_max_size", 1024))
        upscale_model = v2_cfg.get("upscale_model", "RealESRGAN_x2plus.pth")
        target_width = int(v2_cfg.get("target_width", 1080))
        target_height = int(v2_cfg.get("target_height", 1920))
        workflow = {
            "20": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
            "23": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
            "24": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["23", 1]}},
            "25": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["23", 1]}},
        }
        source_image = ["20", 0]
        if use_detail:
            workflow["21"] = {"class_type": "LoadImage", "inputs": {"image": mask_filename}}
            workflow["22"] = {
                "class_type": "MaskToSEGS",
                "inputs": {
                    "mask": ["21", 1],
                    "combined": True,
                    "crop_factor": crop_factor,
                    "bbox_fill": False,
                    "drop_size": 10,
                    "contour_fill": False,
                },
            }
            workflow["26"] = {
                "class_type": "DetailerForEach",
                "inputs": {
                    "image": ["20", 0],
                    "segs": ["22", 0],
                    "model": ["23", 0],
                    "clip": ["23", 1],
                    "vae": ["23", 2],
                    "guide_size": guide_size,
                    "guide_size_for": True,
                    "max_size": max_size,
                    "seed": seed + 2,
                    "steps": face_steps,
                    "cfg": face_cfg,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "positive": ["24", 0],
                    "negative": ["25", 0],
                    "denoise": face_denoise,
                    "feather": 5,
                    "noise_mask": True,
                    "force_inpaint": True,
                    "wildcard": "",
                    "cycle": 1,
                },
            }
            source_image = ["26", 0]
        workflow["27"] = {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": upscale_model},
        }
        workflow["28"] = {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["27", 0], "image": source_image},
        }
        workflow["29"] = {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["28", 0],
                "upscale_method": "lanczos",
                "width": target_width,
                "height": target_height,
                "crop": "center",
            },
        }
        workflow["30"] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["29", 0], "filename_prefix": "manju_v2_detail"},
        }
        return workflow

    def submit_workflow(self, workflow):
        client_id = str(uuid.uuid4())
        payload = {"prompt": workflow, "client_id": client_id}
        resp = self.client.post(f"{self.base_url}/prompt", json=payload)
        resp.raise_for_status()
        prompt_id = resp.json().get("prompt_id")
        if not prompt_id:
            self._log("error", "POST /prompt returned no prompt_id: " + resp.text)
            raise RuntimeError("POST /prompt returned no prompt_id")
        self._log("info", f"prompt queued: prompt_id={prompt_id}")
        return prompt_id

    def wait_workflow(self, prompt_id):
        deadline = time.time() + self.timeout_seconds
        while time.time() < deadline:
            time.sleep(5)
            history = self._get_history(prompt_id)
            if history:
                outputs = history[prompt_id].get("outputs", {})
                images = []
                for node_output in outputs.values():
                    images.extend(node_output.get("images", []))
                if images:
                    return images
            status = history.get(prompt_id, {}).get("status", {}) if history else {}
            if status.get("status_str") == "error":
                self._log("error", f"comfy execution error: {status}")
                raise RuntimeError("ComfyUI execution error: " + str(status))
        raise TimeoutError(
            f"ComfyUI 渲染超时: {self.timeout_seconds}s, prompt_id={prompt_id}"
        )

    def run_workflow(self, workflow, filename_prefix, shot):
        prompt_id = self.submit_workflow(workflow)
        images = self.wait_workflow(prompt_id)
        image_meta = images[0]
        image_path = self._download_image(
            image_meta,
            target_name=f"{filename_prefix}_{shot['shot_id']}_{image_meta['filename']}",
        )
        return {
            "shot_id": shot["shot_id"],
            "prompt_id": prompt_id,
            "seed": shot.get("seed"),
            "image_path": str(image_path),
            "filename": image_meta["filename"],
        }

    def _get_history(self, prompt_id):
        try:
            resp = self.client.get(f"{self.base_url}/history/{prompt_id}")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self._log("warning", f"GET /history failed: {e}")
            return {}

    def _download_image(self, image_meta, target_name):
        params = {
            "filename": image_meta["filename"],
            "subfolder": image_meta.get("subfolder", ""),
            "type": image_meta.get("type", "output"),
        }
        resp = self.client.get(f"{self.base_url}/view", params=params)
        resp.raise_for_status()
        target = self.output_dir / target_name
        target.write_bytes(resp.content)
        return target
