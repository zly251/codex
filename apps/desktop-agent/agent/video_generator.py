import asyncio
import contextlib
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

import edge_tts
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "C:\\Windows\\Fonts\\msyh.ttc"


def _find_ffmpeg():
    try:
        import imageio_ffmpeg as ff

        exe = ff.get_ffmpeg_exe()
        if os.path.exists(exe):
            return exe
    except Exception:
        pass
    for c in ["ffmpeg", "ffmpeg.exe"]:
        try:
            import shutil

            p = shutil.which(c)
            if p:
                return p
        except Exception:
            pass
    return None


FFMPEG = _find_ffmpeg()


def _get_audio_duration(path):
    """Get audio duration by parsing ffmpeg stderr output"""
    try:
        r = subprocess.run(
            [FFMPEG, "-i", path, "-f", "null", "-"], capture_output=True, text=True, timeout=30
        )
        # Parse "Duration: HH:MM:SS.mmm" from stderr
        m = re.search(r"Duration: (d+):(d+):(d+.d+)", r.stderr)
        if m:
            h, m_, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
            return h * 3600 + m_ * 60 + s
    except Exception:
        pass
    return 10.0


class VideoGenerator:
    def __init__(self, output_dir):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _generate_audio(self, text, voice="zh-CN-XiaoxiaoNeural"):
        uid = uuid.uuid4().hex[:8]
        path = os.path.join(tempfile.gettempdir(), f"_tts_{uid}.mp3")
        try:
            asyncio.run(edge_tts.Communicate(text, voice).save(path))
            if not os.path.exists(path) or os.path.getsize(path) < 100:
                print("[warn] TTS failed or audio too small")
                return None
            return path
        except Exception as e:
            print(f"[warn] TTS: {e}")
            return None

    def _create_text_frame(self, text, size=(1080, 1920), font_size=60):
        uid = uuid.uuid4().hex[:8]
        path = os.path.join(tempfile.gettempdir(), f"_frame_{uid}.png")
        img = Image.new("RGB", size, color=(20, 20, 30))
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype(FONT_PATH, font_size)
        except Exception:
            font = ImageFont.load_default()

        lines = []
        for paragraph in text.split(chr(10)):
            line = paragraph
            while True:
                bbox = draw.textbbox((0, 0), line, font=font)
                if bbox[2] - bbox[0] <= size[0] - 200:
                    lines.append(line)
                    break
                cut = len(line) - 1
                while cut > 0:
                    bbox = draw.textbbox((0, 0), line[:cut], font=font)
                    if bbox[2] - bbox[0] <= size[0] - 200:
                        break
                    cut -= 1
                lines.append(line[:cut])
                line = line[cut:]

        total_h = len(lines) * (font_size + 20)
        y_start = (size[1] - total_h) // 2
        for i, line in enumerate(lines):
            bbox = draw.textbbox((0, 0), line, font=font)
            x = (size[0] - (bbox[2] - bbox[0])) // 2
            y = y_start + i * (font_size + 20)
            draw.text((x, y), line, font=font, fill=(255, 255, 255))

        img.save(path)
        return path

    def generate_video(self, title, content, output_name="output.mp4"):
        if FFMPEG is None:
            print("[error] ffmpeg not found")
            return None

        paragraphs = [p.strip() for p in content.split(chr(10)) if p.strip()]
        if not paragraphs:
            paragraphs = [content]

        full_text = title + "\u3002" + "".join(paragraphs)
        print("[audio] generating speech...")
        audio_path = self._generate_audio(full_text)
        audio_duration = 10.0
        if audio_path:
            audio_duration = _get_audio_duration(audio_path)
            print(f"[audio] duration: {audio_duration:.1f}s")

        char_count = max(sum(len(p) for p in paragraphs) + len(title), 1)
        frame_paths = []

        # title frame
        fp = self._create_text_frame(title, font_size=80)
        d = max(2.0, audio_duration * len(title) / char_count)
        frame_paths.append((fp, d))

        # paragraph frames
        for para in paragraphs:
            if not para:
                continue
            fp = self._create_text_frame(para, font_size=55)
            d = max(3.0, audio_duration * len(para) / char_count)
            frame_paths.append((fp, d))

        # --- build ffmpeg concat file ---
        tmpdir = tempfile.mkdtemp()
        concat_file = os.path.join(tmpdir, "concat.txt")
        with open(concat_file, "w", encoding="utf-8") as f:
            f.write("ffconcat version 1.0\n")
            for fp_path, dur in frame_paths[:-1]:
                # escape single quotes for concat format
                esc = fp_path.replace("'", "'\\'")
                f.write(f"file '{esc}'\n")
                f.write(f"duration {dur:.3f}\n")
            esc_last = frame_paths[-1][0].replace("'", "'\\'")
            f.write(f"file '{esc_last}'\n")

        # --- run ffmpeg ---
        output_path = self.output_dir / (Path(output_name).stem + ".mp4")
        try:
            cmd = [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_file]
            if audio_path and os.path.exists(audio_path):
                cmd += ["-i", audio_path]
                cmd += ["-c:a", "aac", "-shortest"]
            else:
                cmd += ["-an"]

            cmd += [
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "medium",
                "-crf",
                "23",
                "-vf",
                "scale=1080:1920:force_original_aspect_ratio=decrease,"
                "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
                "-movflags",
                "+faststart",
                str(output_path),
            ]

            print("[ffmpeg] running...")
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            if r.returncode != 0:
                err = r.stderr[:600] if r.stderr else "unknown error"
                print(f"[ffmpeg] error: {err}")
                return None

            if not os.path.exists(output_path) or os.path.getsize(output_path) < 1000:
                stderr_info = r.stderr[:300] if r.stderr else "no output"
                print(f"[ffmpeg] output empty. stderr: {stderr_info}")
                return None

            size_mb = os.path.getsize(output_path) / (1024 * 1024)
            print(f"[done] video: {output_path} ({size_mb:.1f} MB)")
            return output_path

        except subprocess.TimeoutExpired:
            print("[error] ffmpeg timed out (5 min)")
            return None
        except Exception as e:
            print(f"[error] ffmpeg: {e}")
            return None
        finally:
            for fp, _ in frame_paths:
                with contextlib.suppress(Exception):
                    os.remove(fp)
            try:
                os.remove(concat_file)
                os.rmdir(tmpdir)
            except Exception:
                pass
            if audio_path:
                with contextlib.suppress(Exception):
                    os.remove(audio_path)
