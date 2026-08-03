import json
import sys
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.data import db
from app.web.review_dashboard import create_app

RUN_ID = "20260731_171708"


def main():
    config = json.loads(
        (PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8")
    )
    output_dir = PROJECT_ROOT / config["paths"]["output_dir"]
    db_path = db.init_db(PROJECT_ROOT / config["paths"]["data_dir"] / "manju.sqlite3")
    app = create_app(project_dir=PROJECT_ROOT)
    app.testing = True
    client = app.test_client()

    page = client.get(f"/review/{RUN_ID}")
    data_resp = client.get(f"/review/{RUN_ID}/data.json")
    data = data_resp.get_json()

    checks = {
        "page_ok": page.status_code == 200,
        "page_has_buttons": all(t in page.get_data(as_text=True) for t in ["通过", "修改", "废弃"]),
        "data_tags_complete": all(
            t in (data.get("problem_tags") or [])
            for t in ["人物不一致", "画风不统一", "图片质量差", "剧情不好看", "声音不匹配", "字幕问题", "节奏问题"]
        ),
        "data_ok": data_resp.status_code == 200,
        "video_present": bool(data.get("video")),
        "images_16": len(data.get("images") or []) == 16,
        "audio_16": len(data.get("audio") or []) == 16,
        "script_present": bool(data.get("script")),
        "storyboard_present": bool(data.get("storyboard")),
        "prompts_present": bool(data.get("prompts")),
        "qa_present": bool(data.get("qa")),
        "content_score_present": bool(data.get("content_score")),
        "media_video_ok": False,
        "media_video_content_type": False,
        "media_video_range_206": False,
        "page_data_is_object": False,
        "live_http_200": False,
        "live_content_type": False,
        "live_range_206": False,
        "media_image_ok": False,
        "review_saved": False,
        "review_reopen": False,
        "db_review": False,
    }
    if data.get("video"):
        video_resp = client.get(data["video"]["url"])
        checks["media_video_ok"] = video_resp.status_code == 200
        checks["media_video_content_type"] = video_resp.headers.get(
            "Content-Type", ""
        ).startswith("video/mp4")
        range_resp = client.get(
            data["video"]["url"], headers={"Range": "bytes=0-1023"}
        )
        checks["media_video_range_206"] = (
            range_resp.status_code == 206
            and "Content-Range" in range_resp.headers
        )
    if data.get("images"):
        checks["media_image_ok"] = client.get(data["images"][0]["url"]).status_code == 200

    page_text = page.get_data(as_text=True)
    checks["page_data_is_object"] = (
        "const DATA = {" in page_text and 'const DATA = "' not in page_text
    )

    live_base = "http://127.0.0.1:5001"
    if data.get("video"):
        try:
            with httpx.Client(base_url=live_base, timeout=10) as http:
                live_video = http.get(data["video"]["url"])
                checks["live_http_200"] = live_video.status_code == 200
                checks["live_content_type"] = live_video.headers.get(
                    "content-type", ""
                ).startswith("video/mp4")
                live_range = http.get(
                    data["video"]["url"], headers={"Range": "bytes=0-1023"}
                )
                checks["live_range_206"] = (
                    live_range.status_code == 206
                    and live_range.headers.get("content-range", "").startswith(
                        "bytes 0-1023/"
                    )
                )
        except Exception as exc:
            print(f"live server check skipped/failed: {exc}")

    save_resp = client.post(
        f"/review/{RUN_ID}",
        json={
            "run_id": RUN_ID,
            "status": "通过",
            "score": 95,
            "problems": ["人物不一致"],
            "notes": "人工验收测试",
        },
    )
    checks["review_saved"] = save_resp.status_code == 200

    review_path = output_dir / "review" / RUN_ID / "review.json"
    if review_path.exists():
        saved = json.loads(review_path.read_text(encoding="utf-8"))
        checks["review_saved"] = checks["review_saved"] and saved["status"] == "通过" and saved["score"] == 95

    reopened = client.get(f"/review/{RUN_ID}/data.json").get_json()
    checks["review_reopen"] = bool(reopened.get("review")) and reopened["review"]["status"] == "通过"
    row = db.get_review(db_path, RUN_ID)
    checks["db_review"] = bool(row and row["status"] == "通过" and row["score"] == 95)

    result = {"checks": checks, "summary": {
        "video": data.get("video"),
        "images": len(data.get("images") or []),
        "audio": len(data.get("audio") or []),
        "review": reopened.get("review"),
    }}
    (PROJECT_ROOT / "data" / "logs").mkdir(parents=True, exist_ok=True)
    (PROJECT_ROOT / "data" / "logs" / "review_test.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise SystemExit(f"failed checks: {failed}")


if __name__ == "__main__":
    main()
