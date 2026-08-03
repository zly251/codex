import argparse
import json
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
RUN_ID = "20260731_171708"


def _files(paths):
    result = []
    for path in paths:
        if path.is_file():
            result.append(path)
        elif path.is_dir():
            result.extend(p for p in path.rglob("*") if p.is_file())
    return result


def build_plan(include_v1=False):
    p = PROJECT_DIR
    v2 = p / "output" / "v2_images" / RUN_ID
    plan = {}

    def add(name, paths, note=""):
        paths = sorted({path.resolve() for path in _files(paths)})
        if not paths:
            return
        size = sum(path.stat().st_size for path in paths)
        plan[name] = {"size": size, "count": len(paths), "note": note, "paths": paths}

    add(
        "v2_raw_duplicates",
        list(v2.glob("v2a_*.png"))
        + list(v2.glob("v2b_*.png"))
        + list(v2.glob("v2ref_*.png")),
        "ComfyUI raw duplicates of final shot_*.png / shot_*_hires.png",
    )
    add("smoke_test_images", [p / "output" / "v2_images" / "smoke"], "smoke test residue")

    if include_v1:
        add("old_v1_images", [p / "output" / "images"], "old V1 raw renders, keep only after DB check")

    add("video_intermediate_work", [p / "output" / "video" / "work"], "per-shot mp4/m4a intermediates")
    add("video_duplicate_final_work", [p / "output" / "video" / "final_work" / RUN_ID], "duplicate of run-specific final_work")
    add("video_draft", [p / "output" / "video" / "episode_draft.mp4"], "old draft video")

    vision_out = p / "output" / "vision_test"
    add(
        "vision_test_raw",
        [path for path in vision_out.rglob("*.png") if path.name != "shot_013_v3.png"],
        "raw ComfyUI output; canonical shot_013_v3.png is kept",
    )
    add(
        "vision_test_old_reports",
        list((p / "data" / "vision_test").glob("*.json")),
        "old root reports; current v3/ is kept",
    )
    add("stability_test", [p / "data" / "stability-test"], "stability test residue")
    add(
        "old_runs",
        [p / "data" / "runs" / "20260731_154932", p / "data" / "runs" / "20260731_162700"],
        "older runs; latest run is kept",
    )
    add(
        "old_review_dirs",
        [
            p / "output" / "review" / "20260731_162700",
            p / "output" / "review" / "20260731_162757",
            p / "output" / "review" / "20260731_182032",
        ],
        "old review data; 20260731_171708 is kept",
    )

    logs = p / "data" / "logs"
    add(
        "log_test_artifacts",
        list(logs.glob("frame_*.png"))
        + list(logs.glob("cq_*.png"))
        + list(logs.glob("seg_*.wav"))
        + list(logs.glob("*_test.json"))
        + list(logs.glob("review5001.*.log")),
        "test frames and no-longer-needed logs",
    )

    add(
        "temp_write_files",
        list(p.glob("data/*_writetest.tmp"))
        + list(p.glob("data/_pswrite.tmp"))
        + list(p.glob("output/_writetest.tmp"))
        + list((p / "output" / "v2_images").rglob("__codex_write_test.tmp"))
        + list((p / "output" / "video").rglob("_writetest.tmp")),
        "filesystem write-test residue",
    )

    add(
        "root_duplicate_artifacts",
        list((p / "output" / "audio").glob("shot_*.mp3"))
        + [p / "output" / "audio" / "audio_manifest.json"]
        + list((p / "output" / "subtitle").glob("*.ass"))
        + list((p / "output" / "subtitle").glob("*.json"))
        + list((p / "output" / "cover").glob("cover.jpg"))
        + list((p / "output" / "cover").glob("tags.json"))
        + list((p / "output" / "cover").glob("title.txt"))
        + [p / "output" / "score" / "content_score.json"],
        "root copies; run-specific copies are kept",
    )

    return plan


def _validate(paths):
    root = PROJECT_DIR.resolve()
    for path in paths:
        resolved = path.resolve()
        if not str(resolved).startswith(str(root)):
            raise RuntimeError(f"refusing path outside project: {resolved}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="actually delete; default is dry-run")
    parser.add_argument("--yes", action="store_true", help="required together with --apply")
    parser.add_argument("--include-v1", action="store_true", help="include old output/images candidates")
    parser.add_argument("--category", action="append", default=[])
    args = parser.parse_args()

    plan = build_plan(include_v1=args.include_v1)
    selected = list(plan)
    if args.category:
        selected = [name for name in args.category if name in plan]

    total = sum(plan[name]["size"] for name in selected)
    report = {
        "dry_run": not args.apply,
        "total_size_bytes": total,
        "groups": {
            name: {"count": plan[name]["count"], "size": plan[name]["size"], "note": plan[name]["note"]}
            for name in selected
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if not args.apply:
        return
    if not args.yes:
        raise SystemExit("--apply requires --yes")

    deleted = 0
    zeroed = 0
    skipped = 0
    for name in selected:
        paths = plan[name]["paths"]
        _validate(paths)
        for path in paths:
            try:
                path.unlink(missing_ok=True)
                deleted += 1
                continue
            except OSError:
                pass
            try:
                with path.open("wb") as fh:
                    fh.truncate(0)
                zeroed += 1
            except OSError as e:
                skipped += 1
                print(f"skip {path}: {e}")

    for name in selected:
        for path in plan[name]["paths"]:
            parent = path.parent
            while parent != PROJECT_DIR and str(parent).startswith(str(PROJECT_DIR)):
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent

    print(
        json.dumps(
            {
                "applied": True,
                "deleted": deleted,
                "zeroed": zeroed,
                "skipped": skipped,
                "deleted_groups": selected,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
