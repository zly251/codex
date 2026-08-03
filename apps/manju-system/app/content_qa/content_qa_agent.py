import json
import os
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image

from app.data import db
from app.utils.deepseek_client import DeepSeekClient
from app.utils.llm import chat_json

HOOK_KEYWORDS = [
    "遗产",
    "继承",
    "律师",
    "秘密",
    "豪门",
    "穷",
    "突然",
    "假的",
    "骗",
    "谁",
    "危机",
    "重生",
    "穿越",
    "系统",
]
TITLE_KEYWORDS = ["继承", "意外", "豪门", "秘密", "真相", "逆袭", "重生", "穿越", "假", "失踪"]
POSITIVE_WORDS = ["甜", "爱", "乖", "温暖", "开心", "好", "谢谢", "幸福", "笑"]
NEGATIVE_WORDS = [
    "假",
    "骗",
    "瞒",
    "死",
    "哭",
    "震惊",
    "颤抖",
    "阴影",
    "冷笑",
    "为什么",
    "难",
    "穷",
]
EMOTION_SCENE_MOOD = {
    "压抑": -0.3,
    "温馨": 0.5,
    "震惊": -0.7,
    "混乱": -0.5,
    "复杂": 0.1,
    "悬疑": 0.2,
    "愤怒": -0.8,
    "悲伤": -0.6,
    "开心": 0.7,
    "甜蜜": 0.8,
}


def clamp(value, low=0, high=100):
    return max(low, min(high, round(value)))


class ContentScoreAgent:
    def __init__(self, run_id, output_dir, db_path, logger, ffmpeg=None, tmp_dir=None):
        self.run_id = run_id
        self.output_dir = Path(output_dir)
        self.db_path = db_path
        self.logger = logger
        self.tmp_dir = Path(tmp_dir) if tmp_dir else Path(output_dir).parent / "logs"
        if ffmpeg is None:
            try:
                import imageio_ffmpeg

                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                ffmpeg = "ffmpeg"
        self.ffmpeg = ffmpeg

    def _ffmpeg(self, args, timeout=120):
        result = subprocess.run(
            [self.ffmpeg] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout)[-1500:])
        return result

    def _frame(self, video_path, seconds, out_path):
        self._ffmpeg(
            [
                "-y",
                "-ss",
                str(seconds),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                str(out_path),
            ]
        )
        return np.asarray(Image.open(out_path).convert("L"), dtype=np.float32)

    def _motion_first3s(self, video_path):
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        f1 = self.tmp_dir / f"cq_{self.run_id}_f1.png"
        f2 = self.tmp_dir / f"cq_{self.run_id}_f2.png"
        a = self._frame(video_path, 0.3, f1)
        b = self._frame(video_path, 2.5, f2)
        return float(np.abs(a - b).mean())

    def _audio_rms(self, video_path, start, duration):
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        wav = self.tmp_dir / f"cq_{self.run_id}_{int(start * 10)}.wav"
        self._ffmpeg(
            [
                "-y",
                "-ss",
                str(start),
                "-t",
                str(duration),
                "-i",
                str(video_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(wav),
            ]
        )
        with wave.open(str(wav), "rb") as w:
            data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if len(data) == 0:
            return 0.0
        return float(np.sqrt((data.astype(np.float64) ** 2).mean()))

    def _subtitle_metrics(self, subtitle_manifest):
        items = subtitle_manifest.get("items") or []
        empty_shots = [
            it["shot_id"]
            for it in items
            if it.get("status") == "done" and not (it.get("text") or "").strip()
        ]
        total_chars = sum(len(it.get("text") or "") for it in items if it.get("status") == "done")
        total_duration = float(subtitle_manifest.get("total_duration") or 0.0)
        first_text = ""
        first_shot_duration = 0.0
        if items and items[0].get("status") == "done":
            first_text = items[0].get("text") or ""
            first_shot_duration = float(items[0].get("duration") or 0.0)
        density = round(total_chars / total_duration, 3) if total_duration > 0 else 0.0
        return {
            "total_chars": total_chars,
            "total_duration": total_duration,
            "density": density,
            "empty_shots": empty_shots,
            "first_text": first_text,
            "first_shot_duration": first_shot_duration,
        }

    def _shot_pacing(self, audio_manifest):
        durations = [
            float(it.get("duration") or 0.0)
            for it in (audio_manifest.get("items") or [])
            if it.get("status") == "done"
        ]
        if not durations:
            return {"mean": 0.0, "std": 0.0, "count": 0}
        arr = np.array(durations)
        return {
            "mean": round(float(arr.mean()), 3),
            "std": round(float(arr.std()), 3),
            "count": len(arr),
        }

    def _scene_emotion(self, script):
        scenes = script.get("scenes") or []
        values = []
        for scene in scenes:
            dialogue = " ".join(scene.get("dialogue") or [])
            mood_value = 0.0
            for word, value in EMOTION_SCENE_MOOD.items():
                if word in (scene.get("mood") or ""):
                    mood_value += value
            pos = sum(dialogue.count(w) for w in POSITIVE_WORDS)
            neg = sum(dialogue.count(w) for w in NEGATIVE_WORDS)
            values.append(round(float(np.tanh(mood_value + pos * 0.35 - neg * 0.35)), 3))
        return values

    def _cover_stats(self, cover_path):
        image = Image.open(cover_path).convert("RGB")
        arr = np.asarray(image, dtype=np.float32)
        hsv = np.asarray(Image.open(cover_path).convert("HSV"), dtype=np.float32)
        return {
            "width": image.width,
            "height": image.height,
            "brightness": round(float(arr.mean()), 2),
            "contrast": round(float(arr.std()), 2),
            "saturation": round(float(hsv[:, :, 1].mean() / 255.0), 3),
        }

    def _score(self, script, storyboard, video, subtitle_manifest, audio_manifest, cover):
        hook_motion = self._motion_first3s(video)
        hook_rms = self._audio_rms(video, 0.0, 3.0)
        sub = self._subtitle_metrics(subtitle_manifest)
        pacing = self._shot_pacing(audio_manifest)
        emotions = self._scene_emotion(script)
        cover_stats = self._cover_stats(cover)

        hook_score = 0
        if sub["first_text"].strip():
            hook_score += 30
        if any(kw in sub["first_text"] for kw in HOOK_KEYWORDS):
            hook_score += 25
        if hook_motion >= 8:
            hook_score += 20
        elif hook_motion >= 3:
            hook_score += 12
        if hook_rms >= 300:
            hook_score += 25
        elif hook_rms >= 100:
            hook_score += 15
        hook_score = clamp(hook_score)

        story_score = 0
        if script.get("hook") and script.get("cliffhanger") and script.get("logline"):
            story_score += 20
        if emotions:
            emotion_range = max(emotions) - min(emotions)
            emotion_std = float(np.array(emotions).std())
            if emotion_range >= 1.0:
                story_score += 25
            elif emotion_range >= 0.5:
                story_score += 15
            if emotion_std >= 0.4:
                story_score += 15
            elif emotion_std >= 0.2:
                story_score += 8
            if emotions[-1] < 0:
                story_score += 15
            if emotions[0] > 0:
                story_score += 10
        if script.get("cliffhanger"):
            story_score += 15
        story_score = clamp(story_score)

        visual_score = 0
        if pacing["mean"]:
            if 2.5 <= pacing["mean"] <= 6.0:
                visual_score += 45
            elif 2.0 <= pacing["mean"] <= 8.0:
                visual_score += 35
            else:
                visual_score += 20
            if pacing["std"] >= 1.0:
                visual_score += 20
            elif pacing["std"] >= 0.5:
                visual_score += 12
        if 1.0 <= sub["density"] <= 8.0:
            visual_score += 10
        elif 0.5 <= sub["density"] <= 10.0:
            visual_score += 6
        visual_score += 15  # Ken Burns / transitions added by M4
        visual_score = clamp(visual_score)

        title = script.get("title") or ""
        title_score = 0
        title_len = len(title)
        if 4 <= title_len <= 15:
            title_score += 40
        elif 2 <= title_len <= 20:
            title_score += 25
        if any(kw in title for kw in TITLE_KEYWORDS):
            title_score += 30
        generic = any(x in title for x in ["第1集", "全集", "短剧"])
        if title and not generic:
            title_score += 15
        topic = script.get("topic") or ""
        if title and topic and title not in topic:
            title_score += 15
        title_score = clamp(title_score)

        cover_score = 0
        if cover_stats["width"] == 1080 and cover_stats["height"] == 1440:
            cover_score += 20
        if 40 <= cover_stats["brightness"] <= 220:
            cover_score += 30
        if cover_stats["contrast"] >= 40:
            cover_score += 25
        if cover_stats["saturation"] >= 0.12:
            cover_score += 25
        cover_score = clamp(cover_score)

        overall = clamp(
            0.25 * hook_score
            + 0.25 * story_score
            + 0.20 * visual_score
            + 0.15 * title_score
            + 0.15 * cover_score
        )
        return {
            "hook_score": hook_score,
            "story_score": story_score,
            "visual_score": visual_score,
            "title_score": title_score,
            "cover_score": cover_score,
            "overall_score": overall,
            "metrics": {
                "hook_motion": round(hook_motion, 2),
                "hook_rms": round(hook_rms, 2),
                "subtitle_density": sub["density"],
                "empty_subtitle_shots": sub["empty_shots"],
                "shot_pacing": pacing,
                "emotion_curve": emotions,
                "cover": cover_stats,
            },
        }

    def _problems_suggestions(self, script, scores, sub, pacing):
        problems = []
        suggestions = []
        if sub["empty_shots"]:
            problems.append(f"无对白镜头缺少字幕: {', '.join(sub['empty_shots'])}")
            suggestions.append("为静音镜头补旁白或环境字幕，维持信息密度")
        if not sub["first_text"].strip():
            problems.append("前3秒无字幕，开场抓力弱")
            suggestions.append("把高冲突对白前置到第1镜")
        if scores["metrics"]["subtitle_density"] < 0.5:
            problems.append("字幕密度过低，叙事信息量不足")
            suggestions.append("压缩无信息镜头或增加对白/旁白")
        if scores["metrics"]["subtitle_density"] > 10:
            problems.append("字幕密度过高，观众来不及阅读")
            suggestions.append("拆分长对白，放慢语速或拆成多镜")
        if pacing["mean"] and pacing["mean"] > 6:
            problems.append(f"镜头节奏偏慢（平均 {pacing['mean']}s/镜）")
            suggestions.append("缩短静音镜头，减少单镜停留时间")
        if pacing["mean"] and pacing["mean"] < 2:
            problems.append("镜头节奏过快，容易造成眩晕")
            suggestions.append("适当延长关键对白镜头")
        if not script.get("cliffhanger"):
            problems.append("结尾缺少钩子，不利于追更")
            suggestions.append("在最后一镜加入悬念台词或反转")
        title = script.get("title") or ""
        if title and (len(title) < 4 or len(title) > 20):
            problems.append("标题长度不理想，吸引力受限")
            suggestions.append("压缩为 4-12 字的强冲突标题")
        cover = scores["metrics"]["cover"]
        if cover["brightness"] < 40:
            problems.append("封面过暗，信息不清晰")
            suggestions.append("提高封面亮度与主体对比")
        if cover["contrast"] < 40:
            problems.append("封面对比度不足")
            suggestions.append("增强主体与背景层次")
        return problems[:8], suggestions[:8]

    def _llm_review(self, script, scores, problems, suggestions):
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            key_file = Path.home() / ".douyin_agent_key"
            if key_file.exists():
                api_key = key_file.read_text(encoding="utf-8").strip()
        if not api_key:
            self.logger.info("no DeepSeek key, rule-based review only")
            return problems, suggestions
        try:
            client = DeepSeekClient(api_key)
            system = (
                "你是短剧内容质量审核专家。根据给定的评分和剧本信息，"
                '只返回JSON，格式为 {"problems": [], "suggestions": []}，'
                "各最多5条，每条不超过40字。"
            )
            user = json.dumps(
                {
                    "scores": {
                        k: v
                        for k, v in scores.items()
                        if k
                        in (
                            "hook_score",
                            "story_score",
                            "visual_score",
                            "title_score",
                            "overall_score",
                        )
                    },
                    "title": script.get("title"),
                    "hook": script.get("hook"),
                    "cliffhanger": script.get("cliffhanger"),
                },
                ensure_ascii=False,
            )
            result = chat_json(client, system, user, self.logger, temperature=0.3, retries=1)
            llm_problems = result.get("problems") or []
            llm_suggestions = result.get("suggestions") or []
            merged_problems = list(problems)
            merged_suggestions = list(suggestions)
            for item in llm_problems:
                if item not in merged_problems:
                    merged_problems.append(item)
            for item in llm_suggestions:
                if item not in merged_suggestions:
                    merged_suggestions.append(item)
            return merged_problems[:8], merged_suggestions[:8]
        except Exception as e:
            self.logger.warning("LLM review skipped: %s", e)
            return problems, suggestions

    def run(
        self,
        script_path,
        storyboard_path,
        video_path,
        cover_path,
        subtitle_manifest_path,
        audio_manifest_path,
    ):
        self.output_dir.mkdir(parents=True, exist_ok=True)
        score_path = self.output_dir / "content_score.json"
        existing = db.get_content_score(self.db_path, self.run_id)
        if (
            existing
            and existing["status"] == "done"
            and existing["score_path"]
            and Path(existing["score_path"]) == score_path
            and score_path.exists()
        ):
            self.logger.info("content score already done, skip")
            return json.loads(existing["scores"])

        try:
            script = json.loads(Path(script_path).read_text(encoding="utf-8"))
            storyboard = json.loads(Path(storyboard_path).read_text(encoding="utf-8"))
            subtitle_manifest = json.loads(Path(subtitle_manifest_path).read_text(encoding="utf-8"))
            audio_manifest = json.loads(Path(audio_manifest_path).read_text(encoding="utf-8"))
            scores = self._score(
                script,
                storyboard,
                Path(video_path),
                subtitle_manifest,
                audio_manifest,
                Path(cover_path),
            )
            sub = self._subtitle_metrics(subtitle_manifest)
            pacing = self._shot_pacing(audio_manifest)
            problems, suggestions = self._problems_suggestions(script, scores, sub, pacing)
            problems, suggestions = self._llm_review(script, scores, problems, suggestions)
            result = {
                "hook_score": scores["hook_score"],
                "story_score": scores["story_score"],
                "visual_score": scores["visual_score"],
                "title_score": scores["title_score"],
                "overall_score": scores["overall_score"],
                "problems": problems,
                "suggestions": suggestions,
                "metrics": scores["metrics"],
            }
            score_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            db.upsert_content_score(
                self.db_path,
                self.run_id,
                "done",
                score_path=str(score_path),
                scores=json.dumps(result, ensure_ascii=False),
            )
            self.logger.info(
                "content score done: overall=%s path=%s",
                result["overall_score"],
                score_path,
            )
            return result
        except Exception as e:
            db.upsert_content_score(
                self.db_path,
                self.run_id,
                "failed",
                error=str(e),
            )
            raise
