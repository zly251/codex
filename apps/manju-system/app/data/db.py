import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    output_path TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, step_name)
);

CREATE TABLE IF NOT EXISTS shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    seed INTEGER,
    prompt_path TEXT,
    image_path TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, shot_id)
);

CREATE TABLE IF NOT EXISTS audio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    audio_path TEXT,
    duration REAL,
    voice TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, shot_id)
);

CREATE TABLE IF NOT EXISTS subtitle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    start_sec REAL,
    end_sec REAL,
    duration REAL,
    event_index INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, shot_id)
);

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    video_path TEXT,
    duration REAL,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    clip_path TEXT,
    duration REAL,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, shot_id)
);

CREATE TABLE IF NOT EXISTS final_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    video_path TEXT,
    duration REAL,
    size_bytes INTEGER,
    effects TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS covers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    cover_path TEXT,
    title_path TEXT,
    tags_path TEXT,
    title TEXT,
    tags TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    score_path TEXT,
    scores TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'real',
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    completion_rate REAL,
    retention_3s REAL,
    interaction_rate REAL,
    real_score REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, source)
);

CREATE TABLE IF NOT EXISTS score_accuracy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    prediction_score REAL,
    real_score REAL,
    difference REAL,
    report_path TEXT,
    recommendations TEXT,
    report_json TEXT,
    error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT,
    score INTEGER,
    problems TEXT,
    notes TEXT,
    review_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def now():
    return datetime.now().isoformat(timespec="seconds")


def _connect(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    # E 盘禁止删除回滚日志文件，使用内存日志避免 disk I/O error
    conn.execute("PRAGMA journal_mode=MEMORY")
    conn.execute("PRAGMA synchronous=OFF")
    return conn


def _create_schema(db_path):
    db_path = Path(db_path)
    with _connect(db_path) as conn:
        conn.executescript(SCHEMA)
        for table, column, decl in [
            ("shots", "qa_score", "REAL"),
            ("shots", "qa_retries", "INTEGER NOT NULL DEFAULT 0"),
            ("score_accuracy", "retries", "INTEGER NOT NULL DEFAULT 0"),
        ]:
            cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init_db(db_path):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        _create_schema(db_path)
        return str(db_path)
    except sqlite3.OperationalError:
        # 旧文件可能因 E 盘权限损坏，尝试删除后重建；删除失败则换新文件
        try:
            os.remove(db_path)
        except OSError:
            db_path = db_path.with_name(db_path.stem + ".sqlite3")
        _create_schema(db_path)
        return str(db_path)


def create_run(db_path, run_id, topic):
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO runs (id, topic, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (run_id, topic, "running", now(), now()),
        )


def get_run(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return dict(row) if row else None


def update_run(db_path, run_id, status=None, error=None, clear_error=False):
    with _connect(db_path) as conn:
        conn.execute(
            """
            UPDATE runs SET
                status = COALESCE(?, status),
                error = CASE WHEN ? THEN NULL ELSE COALESCE(?, error) END,
                updated_at = ?
            WHERE id = ?
            """,
            (status, clear_error, error, now(), run_id),
        )


def get_step(db_path, run_id, step_name):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM steps WHERE run_id = ? AND step_name = ?", (run_id, step_name)
        ).fetchone()
    return dict(row) if row else None


def upsert_step(db_path, run_id, step_name, status, output_path=None, error=None, retries=0):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO steps (run_id, step_name, status, output_path, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, step_name) DO UPDATE SET
                status = excluded.status,
                output_path = excluded.output_path,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (run_id, step_name, status, output_path, error, retries, now(), now()),
        )


def get_shot(db_path, run_id, shot_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM shots WHERE run_id = ? AND shot_id = ?", (run_id, shot_id)
        ).fetchone()
    return dict(row) if row else None


def upsert_shot(
    db_path,
    run_id,
    shot_id,
    status,
    seed=None,
    prompt_path=None,
    image_path=None,
    error=None,
    retries=0,
    qa_score=None,
    qa_retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO shots (run_id, shot_id, status, seed, prompt_path, image_path, error, retries, qa_score, qa_retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, shot_id) DO UPDATE SET
                status = excluded.status,
                seed = excluded.seed,
                prompt_path = excluded.prompt_path,
                image_path = excluded.image_path,
                error = excluded.error,
                retries = excluded.retries,
                qa_score = excluded.qa_score,
                qa_retries = excluded.qa_retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                shot_id,
                status,
                seed,
                prompt_path,
                image_path,
                error,
                retries,
                qa_score,
                qa_retries,
                now(),
                now(),
            ),
        )


def list_shots(db_path, run_id):
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM shots WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def get_audio(db_path, run_id, shot_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM audio WHERE run_id = ? AND shot_id = ?",
            (run_id, shot_id),
        ).fetchone()
    return dict(row) if row else None


def upsert_audio(
    db_path,
    run_id,
    shot_id,
    status,
    audio_path=None,
    duration=None,
    voice=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO audio (run_id, shot_id, status, audio_path, duration, voice, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, shot_id) DO UPDATE SET
                status = excluded.status,
                audio_path = excluded.audio_path,
                duration = excluded.duration,
                voice = excluded.voice,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                shot_id,
                status,
                audio_path,
                duration,
                voice,
                error,
                retries,
                now(),
                now(),
            ),
        )


def list_audio(db_path, run_id):
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM audio WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def upsert_subtitle(
    db_path,
    run_id,
    shot_id,
    status,
    start_sec=None,
    end_sec=None,
    duration=None,
    event_index=None,
    error=None,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO subtitle (run_id, shot_id, status, start_sec, end_sec, duration, event_index, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, shot_id) DO UPDATE SET
                status = excluded.status,
                start_sec = excluded.start_sec,
                end_sec = excluded.end_sec,
                duration = excluded.duration,
                event_index = excluded.event_index,
                error = excluded.error,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                shot_id,
                status,
                start_sec,
                end_sec,
                duration,
                event_index,
                error,
                now(),
                now(),
            ),
        )


def list_subtitle(db_path, run_id):
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM subtitle WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def upsert_video(
    db_path,
    run_id,
    status,
    video_path=None,
    duration=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO videos (run_id, status, video_path, duration, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                video_path = excluded.video_path,
                duration = excluded.duration,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (run_id, status, video_path, duration, error, retries, now(), now()),
        )


def get_video(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM videos WHERE run_id = ?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def upsert_video_clip(
    db_path,
    run_id,
    shot_id,
    status,
    clip_path=None,
    duration=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO video_clips (run_id, shot_id, status, clip_path, duration, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, shot_id) DO UPDATE SET
                status = excluded.status,
                clip_path = excluded.clip_path,
                duration = excluded.duration,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                shot_id,
                status,
                clip_path,
                duration,
                error,
                retries,
                now(),
                now(),
            ),
        )


def list_video_clips(db_path, run_id):
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM video_clips WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def upsert_final_video(
    db_path,
    run_id,
    status,
    video_path=None,
    duration=None,
    size_bytes=None,
    effects=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO final_videos (run_id, status, video_path, duration, size_bytes, effects, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                video_path = excluded.video_path,
                duration = excluded.duration,
                size_bytes = excluded.size_bytes,
                effects = excluded.effects,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                status,
                video_path,
                duration,
                size_bytes,
                effects,
                error,
                retries,
                now(),
                now(),
            ),
        )


def get_final_video(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM final_videos WHERE run_id = ?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def upsert_cover(
    db_path,
    run_id,
    status,
    cover_path=None,
    title_path=None,
    tags_path=None,
    title=None,
    tags=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO covers (run_id, status, cover_path, title_path, tags_path, title, tags, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                cover_path = excluded.cover_path,
                title_path = excluded.title_path,
                tags_path = excluded.tags_path,
                title = excluded.title,
                tags = excluded.tags,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                status,
                cover_path,
                title_path,
                tags_path,
                title,
                tags,
                error,
                retries,
                now(),
                now(),
            ),
        )


def get_cover(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM covers WHERE run_id = ?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def upsert_content_score(
    db_path,
    run_id,
    status,
    score_path=None,
    scores=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO content_scores (run_id, status, score_path, scores, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                score_path = excluded.score_path,
                scores = excluded.scores,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                status,
                score_path,
                scores,
                error,
                retries,
                now(),
                now(),
            ),
        )


def get_content_score(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM content_scores WHERE run_id = ?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def upsert_video_metrics(
    db_path,
    run_id,
    source,
    views=0,
    likes=0,
    comments=0,
    shares=0,
    completion_rate=None,
    retention_3s=None,
    interaction_rate=None,
    real_score=None,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO video_metrics (run_id, source, views, likes, comments, shares, completion_rate, retention_3s, interaction_rate, real_score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, source) DO UPDATE SET
                views = excluded.views,
                likes = excluded.likes,
                comments = excluded.comments,
                shares = excluded.shares,
                completion_rate = excluded.completion_rate,
                retention_3s = excluded.retention_3s,
                interaction_rate = excluded.interaction_rate,
                real_score = excluded.real_score,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                source,
                views,
                likes,
                comments,
                shares,
                completion_rate,
                retention_3s,
                interaction_rate,
                real_score,
                now(),
                now(),
            ),
        )


def get_video_metrics(db_path, run_id):
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM video_metrics WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def upsert_score_accuracy(
    db_path,
    run_id,
    status,
    prediction_score=None,
    real_score=None,
    difference=None,
    report_path=None,
    recommendations=None,
    report_json=None,
    error=None,
    retries=0,
):
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO score_accuracy (run_id, status, prediction_score, real_score, difference, report_path, recommendations, report_json, error, retries, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                prediction_score = excluded.prediction_score,
                real_score = excluded.real_score,
                difference = excluded.difference,
                report_path = excluded.report_path,
                recommendations = excluded.recommendations,
                report_json = excluded.report_json,
                error = excluded.error,
                retries = excluded.retries,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                status,
                prediction_score,
                real_score,
                difference,
                report_path,
                recommendations,
                report_json,
                error,
                retries,
                now(),
                now(),
            ),
        )


def get_score_accuracy(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM score_accuracy WHERE run_id = ?", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def upsert_review(
    db_path,
    run_id,
    status,
    score,
    problems,
    notes,
    review_path=None,
):
    if isinstance(problems, list | tuple):
        problems_json = json.dumps(list(problems), ensure_ascii=False)
    else:
        problems_json = problems or "[]"
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO reviews (run_id, status, score, problems, notes, review_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                score = excluded.score,
                problems = excluded.problems,
                notes = excluded.notes,
                review_path = excluded.review_path,
                updated_at = excluded.updated_at
            """,
            (
                run_id,
                status,
                score,
                problems_json,
                notes,
                review_path,
                now(),
                now(),
            ),
        )


def get_review(db_path, run_id):
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM reviews WHERE run_id = ?", (run_id,)
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    try:
        result["problems"] = json.loads(result.get("problems") or "[]")
    except Exception:
        result["problems"] = []
    return result
