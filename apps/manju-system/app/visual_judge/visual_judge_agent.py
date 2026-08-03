import base64
import io
import json
import logging
import re
import subprocess
from datetime import datetime
from pathlib import Path

import httpx

try:
    from PIL import Image
except ImportError:
    Image = None


def _find_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def _probe_duration(video_path, ffmpeg):
    result = subprocess.run(
        [ffmpeg, "-i", str(video_path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        raise RuntimeError("cannot read video duration")
    hours, minutes, seconds = match.groups()
    return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)


def _extract_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no JSON object in model output")
    return json.loads(text[start : end + 1])


class VisualJudgeAgent:
    def __init__(self, project_dir, config, logger=None):
        self.project_dir = Path(project_dir)
        cfg = config.get("visual_judge", {})
        self.enabled = bool(cfg.get("enabled", True))
        self.base_url = str(cfg.get("base_url", "http://127.0.0.1:11434")).rstrip("/")
        self.model = str(cfg.get("model", "qwen2.5vl:3b"))
        self.keyframe_count = int(cfg.get("keyframe_count", 6))
        self.timeout_seconds = int(cfg.get("timeout_seconds", 900))
        self.ffmpeg = _find_ffmpeg()
        self.logger = logger or logging.getLogger("visual_judge")

    def run(self, run_id):
        report_path = self.project_dir / "output" / "review" / run_id / "visual_judge.json"
        report_dir = report_path.parent
        report_dir.mkdir(parents=True, exist_ok=True)

        if not self.enabled:
            report = self._report(run_id, status="disabled", error="visual judge disabled")
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return report

        try:
            video_path = self._find_video(run_id)
            shot_images = self._find_shot_images(run_id)
            if not video_path:
                raise FileNotFoundError("episode_final.mp4 not found")
            if len(shot_images) < 1:
                raise FileNotFoundError("no shot images found")

            keyframes = self._extract_keyframes(
                video_path, report_dir / "visual_judge_frames", run_id
            )
            clip_qa = self._gather_clip_qa(run_id)
            judge = self._judge(video_path, keyframes, shot_images)
            scores = {
                "character_consistency": judge.get("character_consistency"),
                "scene_specificity": judge.get("scene_specificity"),
                "composition": judge.get("composition"),
                "commercial_quality": judge.get("commercial_quality"),
            }
            report = {
                "run_id": run_id,
                "model": self.model,
                "status": "done",
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "input": {
                    "video": str(video_path),
                    "keyframes": [str(p) for p in keyframes],
                    "shot_images": [str(p) for p in shot_images],
                },
                "scores": scores,
                "problems": judge.get("problems") or [],
                "suggestions": judge.get("suggestions") or [],
                "clip_qa": clip_qa,
                "error": None,
            }
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self.logger.info("visual judge done for %s", run_id)
            return report
        except Exception as e:
            self.logger.error("visual judge failed for %s: %s", run_id, e)
            report = self._report(run_id, status="failed", error=str(e))
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return report

    def _report(self, run_id, status, error=None):
        return {
            "run_id": run_id,
            "model": self.model,
            "status": status,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "scores": None,
            "problems": [],
            "suggestions": [],
            "clip_qa": None,
            "error": error,
        }

    def _find_video(self, run_id):
        candidates = [
            self.project_dir / "output" / "video" / run_id / "episode_final.mp4",
            self.project_dir / "output" / "video" / "episode_final.mp4",
        ]
        for path in candidates:
            if path.exists():
                return path
        return None

    def _find_shot_images(self, run_id):
        render_summary = self.project_dir / "data" / "runs" / run_id / "render_summary.json"
        if render_summary.exists():
            try:
                data = json.loads(render_summary.read_text(encoding="utf-8"))
                paths = [
                    Path(item["image_path"])
                    for item in data
                    if item.get("image_path") and Path(item["image_path"]).exists()
                ]
                if paths:
                    return sorted(
                        paths,
                        key=lambda p: int(re.search(r"shot_(\d+)", p.name).group(1)),
                    )
            except Exception:
                pass
        images_dir = self.project_dir / "output" / "images"
        if not images_dir.exists():
            return []
        pattern = re.compile(rf"^{re.escape(run_id)}_shot_(\d+)")
        matched = []
        for path in images_dir.iterdir():
            if path.is_file() and pattern.match(path.name):
                matched.append(path)
        matched.sort(key=lambda p: int(pattern.match(p.name).group(1)))
        return matched

    def _extract_keyframes(self, video_path, out_dir, run_id):
        out_dir.mkdir(parents=True, exist_ok=True)
        duration = _probe_duration(video_path, self.ffmpeg)
        count = max(1, self.keyframe_count)
        timestamps = [max(0.0, duration * (i + 1) / (count + 1)) for i in range(count)]
        frames = []
        for idx, ts in enumerate(timestamps):
            frame_path = out_dir / f"keyframe_{idx + 1:02d}.jpg"
            result = subprocess.run(
                [
                    self.ffmpeg,
                    "-y",
                    "-ss",
                    f"{ts:.2f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    "-q:v",
                    "4",
                    str(frame_path),
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0 or not frame_path.exists():
                raise RuntimeError(
                    f"keyframe extract failed at {ts:.2f}s: " + (result.stderr or "")[-500:]
                )
            frames.append(frame_path)
        return frames

    def _gather_clip_qa(self, run_id):
        run_dir = self.project_dir / "data" / "runs" / run_id
        if not run_dir.exists():
            return {"enabled": False, "shots": [], "average": None}
        rows = []
        for path in sorted(run_dir.glob("qa_shot_*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                scores = data.get("scores") or {}
                rows.append(
                    {
                        "shot_id": data.get("shot_id") or path.stem,
                        "total": scores.get("total"),
                        "character_consistency": scores.get("character_consistency"),
                        "scene_compliance": scores.get("scene_compliance"),
                        "image_quality": scores.get("image_quality"),
                    }
                )
            except Exception:
                continue
        averages = None
        if rows:
            totals = [r["total"] for r in rows if r["total"] is not None]
            averages = {
                "total": round(sum(totals) / len(totals), 2) if totals else None,
                "shots": len(rows),
            }
        return {"enabled": True, "shots": rows, "average": averages}

    def _judge(self, video_path, keyframes, shot_images):
        images = []
        for frame in keyframes + shot_images:
            images.append(self._image_to_base64(frame))

        system = (
            "你是抖音/红果短剧成片质检员。输入包含成片关键帧和全部分镜图。"
            "用中文输出严格 JSON，不要输出其他文字。字段："
            "character_consistency(人物一致性,0-100),"
            "scene_specificity(场景具体度,0-100),"
            "composition(构图,0-100),"
            "commercial_quality(商业短剧观感,0-100),"
            "problems(问题列表,中文短句),"
            "suggestions(修改建议,中文短句)。"
            "评分标准：抖音/红果短剧成片质感、画面信息量、人物跨镜头一致、"
            "场景细节与氛围、构图重心、字幕配音与画面匹配。"
        )
        user = f"请审核这部短剧。视频关键帧 {len(keyframes)} 张，分镜图 {len(shot_images)} 张。"
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": images},
            ],
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.2, "num_ctx": 32768},
        }
        resp = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout_seconds)
        resp.raise_for_status()
        data = resp.json()
        content = (data.get("message") or {}).get("content") or (data.get("response") or "")
        judge = _extract_json(content)
        if not isinstance(judge, dict):
            raise ValueError("model output is not an object")
        return judge

    def _image_to_base64(self, path, max_side=448, quality=82):
        if Image is None:
            raise RuntimeError("Pillow is required")
        with Image.open(path) as img:
            img = img.convert("RGB")
            img.thumbnail((max_side, max_side), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality)
            return base64.b64encode(buf.getvalue()).decode("ascii")
