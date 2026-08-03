import json
import re
import shutil
import subprocess
from pathlib import Path

from app.data import db

TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920
FPS = 24
CRF = 20


def probe_duration(path):
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ffmpeg = "ffmpeg"
    result = subprocess.run(
        [ffmpeg, "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        raise RuntimeError("cannot read duration")
    hours, minutes, seconds = match.groups()
    return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)


class VideoEditor:
    def __init__(
        self,
        run_id,
        video_dir,
        work_dir,
        db_path,
        logger,
        subtitle_path,
        ffmpeg=None,
    ):
        self.run_id = run_id
        self.video_dir = Path(video_dir)
        self.work_dir = Path(work_dir)
        self.db_path = db_path
        self.logger = logger
        self.subtitle_path = Path(subtitle_path)
        if ffmpeg is None:
            try:
                import imageio_ffmpeg

                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                ffmpeg = "ffmpeg"
        self.ffmpeg = ffmpeg

    def _ffmpeg(self, args, timeout=300, cwd=None):
        result = subprocess.run(
            [self.ffmpeg] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout)[-3000:]
            raise RuntimeError(f"ffmpeg failed: {detail}")
        return result

    def _make_clip(self, image_path, duration, clip_path):
        if clip_path.exists() and abs(probe_duration(clip_path) - duration) < 0.15:
            return
        vf = (
            f"scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
        )
        self._ffmpeg(
            [
                "-y",
                "-loop",
                "1",
                "-i",
                str(image_path),
                "-t",
                f"{duration:.3f}",
                "-r",
                str(FPS),
                "-vf",
                vf,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                str(CRF),
                str(clip_path),
            ],
            timeout=240,
        )

    def run(self, shot_images, audio_manifest):
        audio_by_id = {item["shot_id"]: item for item in (audio_manifest.get("items") or [])}
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)

        clips = []
        for meta in shot_images:
            shot_id = meta["shot_id"]
            image_path = Path(meta["image_path"])
            item = audio_by_id.get(shot_id)
            if not item or item.get("status") != "done":
                db.upsert_video_clip(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "failed",
                    error="audio not done",
                )
                raise RuntimeError(f"audio not done for {shot_id}")
            duration = item.get("duration") or probe_duration(item["audio_path"])
            clip_path = self.work_dir / f"{shot_id}.mp4"
            try:
                self._make_clip(image_path, duration, clip_path)
                actual = probe_duration(clip_path)
                db.upsert_video_clip(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "done",
                    clip_path=str(clip_path),
                    duration=actual,
                )
                clips.append(clip_path)
            except Exception as e:
                db.upsert_video_clip(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "failed",
                    error=str(e),
                )
                raise

        video_list = self.work_dir / "video_list.txt"
        video_list.write_text("".join(f"file '{p.as_posix()}'\n" for p in clips), encoding="utf-8")
        video_concat = self.work_dir / "video_concat.mp4"
        self._ffmpeg(
            [
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(video_list),
                "-c",
                "copy",
                str(video_concat),
            ],
            timeout=300,
        )

        audio_segments = []
        for meta in shot_images:
            shot_id = meta["shot_id"]
            item = audio_by_id[shot_id]
            mp3_path = Path(item["audio_path"])
            segment = self.work_dir / f"{shot_id}.m4a"
            if not (segment.exists() and abs(probe_duration(segment) - item["duration"]) < 0.15):
                self._ffmpeg(
                    [
                        "-y",
                        "-i",
                        str(mp3_path),
                        "-c:a",
                        "aac",
                        "-ar",
                        "44100",
                        "-ac",
                        "2",
                        "-b:a",
                        "128k",
                        str(segment),
                    ],
                    timeout=120,
                )
            audio_segments.append(segment)

        audio_list = self.work_dir / "audio_list.txt"
        audio_list.write_text(
            "".join(f"file '{p.as_posix()}'\n" for p in audio_segments),
            encoding="utf-8",
        )
        audio_concat = self.work_dir / "audio_concat.m4a"
        self._ffmpeg(
            [
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(audio_list),
                "-c",
                "copy",
                str(audio_concat),
            ],
            timeout=120,
        )

        ass_path = self.work_dir / "episode.ass"
        shutil.copyfile(self.subtitle_path, ass_path)
        output = self.video_dir / "episode_draft.mp4"
        self._ffmpeg(
            [
                "-y",
                "-i",
                str(video_concat),
                "-i",
                str(audio_concat),
                "-vf",
                "ass=episode.ass",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                str(CRF),
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-ar",
                "44100",
                "-ac",
                "2",
                str(output),
            ],
            timeout=900,
            cwd=self.work_dir,
        )

        duration = probe_duration(output)
        db.upsert_video(
            self.db_path,
            self.run_id,
            "done",
            video_path=str(output),
            duration=duration,
        )
        report = {
            "run_id": self.run_id,
            "video_path": str(output),
            "duration": duration,
            "shots": len(clips),
            "status": "done",
        }
        report_path = self.work_dir / "video_report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        self.logger.info(
            "video done: duration=%s shots=%s path=%s",
            duration,
            len(clips),
            output,
        )
        return report
