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
TRANSITION_SECONDS = 0.5
KEN_BURNS = ["zoom_in", "zoom_out", "pan_left", "pan_right"]
TRANSITIONS = ["fade", "slideleft", "wipeleft", "smoothleft"]


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
    match = re.search(
        r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or ""
    )
    if not match:
        raise RuntimeError("cannot read duration")
    hours, minutes, seconds = match.groups()
    return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)


class EnhancedVideoEditor:
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

    def _ken_burns_zoompan(self, effect, frames):
        if effect == "zoom_in":
            return (
                "z='min(zoom+0.0018,1.18)'"
                ":x='iw/2-(iw/zoom/2)'"
                ":y='ih/2-(ih/zoom/2)'"
            )
        if effect == "zoom_out":
            return (
                "z='max(zoom-0.0018,1.0)'"
                ":x='iw/2-(iw/zoom/2)'"
                ":y='ih/2-(ih/zoom/2)'"
            )
        if effect == "pan_left":
            return (
                f"z='1.15'"
                f":x='(iw-iw/zoom)*on/{max(frames-1, 1)}'"
                ":y='ih/2-(ih/zoom/2)'"
            )
        return (
            f"z='1.15'"
            f":x='(iw-iw/zoom)*(1-on/{max(frames-1, 1)})'"
            ":y='ih/2-(ih/zoom/2)'"
        )

    def _make_clip(self, image_path, duration, effect, clip_path):
        if clip_path.exists() and abs(probe_duration(clip_path) - duration) < 0.15:
            return
        frames = max(int(round(duration * FPS)), 1)
        vf = (
            f"scale=2160:3840:force_original_aspect_ratio=decrease,"
            f"pad=2160:3840:(ow-iw)/2:(oh-ih)/2,"
            f"zoompan={self._ken_burns_zoompan(effect, frames)}"
            f":d={frames}:s={TARGET_WIDTH}x{TARGET_HEIGHT}:fps={FPS},"
            "format=yuv420p"
        )
        self._ffmpeg(
            [
                "-y",
                "-i",
                str(image_path),
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

    def _voice_concat(self, shot_images, audio_by_id, durations):
        segments = []
        for meta in shot_images:
            shot_id = meta["shot_id"]
            item = audio_by_id[shot_id]
            mp3_path = Path(item["audio_path"])
            segment = self.work_dir / f"{shot_id}.m4a"
            if not (
                segment.exists()
                and abs(probe_duration(segment) - item["duration"]) < 0.15
            ):
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
            segments.append(segment)
        audio_list = self.work_dir / "voice_list.txt"
        audio_list.write_text(
            "".join(f"file '{p.as_posix()}'\n" for p in segments),
            encoding="utf-8",
        )
        voice_concat = self.work_dir / "voice_concat.m4a"
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
                str(voice_concat),
            ],
            timeout=120,
        )
        return voice_concat, sum(durations)

    def _make_bgm(self, voice_seconds):
        bgm_path = self.work_dir / "bgm.m4a"
        duration = round(voice_seconds + 2.0, 3)
        if bgm_path.exists() and abs(probe_duration(bgm_path) - duration) < 0.5:
            return bgm_path
        source = (
            "aevalsrc="
            "'0.04*sin(2*PI*110*t)+0.03*sin(2*PI*130.81*t)"
            "+0.025*sin(2*PI*164.81*t)+0.02*sin(2*PI*220*t)'"
            f":s=44100:d={duration}"
        )
        fade_out_start = max(voice_seconds - 2.0, 0.0)
        self._ffmpeg(
            [
                "-y",
                "-f",
                "lavfi",
                "-i",
                source,
                "-af",
                (
                    "volume=0.9,tremolo=f=0.18:d=0.35,"
                    "afade=t=in:d=2,"
                    f"afade=t=out:st={fade_out_start}:d=2"
                ),
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(bgm_path),
            ],
            timeout=120,
        )
        return bgm_path

    def _mix_audio(self, voice_path, bgm_path):
        mixed = self.work_dir / "mixed_audio.m4a"
        self._ffmpeg(
            [
                "-y",
                "-i",
                str(voice_path),
                "-i",
                str(bgm_path),
                "-filter_complex",
                (
                    "[1:a]volume=0.9[bgm];"
                    "[bgm][0:a]sidechaincompress=threshold=0.02:ratio=12:attack=60:release=350[bgm_duck];"
                    "[0:a][bgm_duck]amix=inputs=2:duration=first:normalize=0[aout]"
                ),
                "-map",
                "[aout]",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-ar",
                "44100",
                "-ac",
                "2",
                str(mixed),
            ],
            timeout=120,
        )
        return mixed

    def run(self, shot_images, audio_manifest):
        existing = db.get_final_video(self.db_path, self.run_id)
        final_output = self.video_dir / "episode_final.mp4"
        if (
            existing
            and existing["status"] == "done"
            and existing["video_path"]
            and Path(existing["video_path"]) == final_output
            and Path(existing["video_path"]).exists()
        ):
            self.logger.info("final video already done, skip: %s", final_output)
            return {
                "run_id": self.run_id,
                "video_path": str(final_output),
                "duration": existing.get("duration"),
                "shots": len(shot_images),
                "status": "done",
                "resumed": True,
            }

        audio_by_id = {
            item["shot_id"]: item for item in (audio_manifest.get("items") or [])
        }
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)

        durations = []
        clips = []
        for index, meta in enumerate(shot_images):
            shot_id = meta["shot_id"]
            image_path = Path(meta["image_path"])
            item = audio_by_id.get(shot_id)
            if not item or item.get("status") != "done":
                raise RuntimeError(f"audio not done for {shot_id}")
            audio_duration = item.get("duration") or probe_duration(
                item["audio_path"]
            )
            durations.append(audio_duration)
            clip_duration = audio_duration + (
                TRANSITION_SECONDS if index < len(shot_images) - 1 else 0.0
            )
            effect = KEN_BURNS[index % len(KEN_BURNS)]
            clip_path = self.work_dir / f"kb_{shot_id}.mp4"
            try:
                self._make_clip(image_path, clip_duration, effect, clip_path)
                clips.append(clip_path)
            except Exception as e:
                self.logger.error("ken burns clip %s failed: %s", shot_id, e)
                raise RuntimeError(f"ken burns clip failed for {shot_id}: {e}")

        ass_path = self.work_dir / "episode.ass"
        shutil.copyfile(self.subtitle_path, ass_path)

        filter_lines = []
        prev_label = "0:v"
        cumulative = 0.0
        for index in range(len(clips) - 1):
            transition = TRANSITIONS[index % len(TRANSITIONS)]
            offset = round(cumulative + durations[index], 3)
            label = f"v{index:02d}"
            filter_lines.append(
                f"[{prev_label}][{index + 1}:v]"
                f"xfade=transition={transition}:duration={TRANSITION_SECONDS}:offset={offset}"
                f"[{label}]"
            )
            prev_label = label
            cumulative += durations[index]
        filter_lines.append(f"[{prev_label}]ass=episode.ass,format=yuv420p[vout]")
        filter_script = self.work_dir / "filter_script.txt"
        filter_script.write_text(";\n".join(filter_lines) + "\n", encoding="utf-8")

        voice_path, voice_seconds = self._voice_concat(
            shot_images, audio_by_id, durations
        )
        bgm_path = self._make_bgm(voice_seconds)
        mixed_path = self._mix_audio(voice_path, bgm_path)

        inputs = []
        for clip in clips:
            inputs += ["-i", str(clip)]
        inputs += ["-i", str(mixed_path)]
        audio_index = len(clips)
        effects_meta = {
            "ken_burns": KEN_BURNS,
            "transition_seconds": TRANSITION_SECONDS,
            "transitions": TRANSITIONS,
            "bgm_duck": True,
            "subtitles": True,
        }
        self._ffmpeg(
            [
                "-y",
            ]
            + inputs
            + [
                "-filter_complex_script",
                str(filter_script),
                "-map",
                "[vout]",
                "-map",
                f"{audio_index}:a",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                str(CRF),
                "-r",
                str(FPS),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                str(final_output),
            ],
            timeout=900,
            cwd=self.work_dir,
        )

        duration = probe_duration(final_output)
        size_bytes = final_output.stat().st_size
        db.upsert_final_video(
            self.db_path,
            self.run_id,
            "done",
            video_path=str(final_output),
            duration=duration,
            size_bytes=size_bytes,
            effects=json.dumps(effects_meta, ensure_ascii=False),
        )
        report = {
            "run_id": self.run_id,
            "video_path": str(final_output),
            "duration": duration,
            "size_bytes": size_bytes,
            "shots": len(clips),
            "effects": effects_meta,
            "status": "done",
        }
        report_path = self.work_dir / "final_report.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.logger.info(
            "final video done: duration=%s size=%s path=%s",
            duration,
            size_bytes,
            final_output,
        )
        return report
