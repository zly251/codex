import json
import random
from pathlib import Path

from app.data import db


def clamp(value, low=0, high=100):
    return max(low, min(high, round(value)))


def simulate_platform_data(run_id, overall_score, hook_score):
    rng = random.Random(f"analytics-{run_id}")
    base_views = int(800 + overall_score * 180)
    views = int(base_views * rng.uniform(0.75, 1.25))
    like_rate = 0.03 + overall_score / 100 * 0.06
    likes = int(views * like_rate * rng.uniform(0.8, 1.2))
    comments = int(likes * rng.uniform(0.05, 0.12))
    shares = int(likes * rng.uniform(0.03, 0.08))
    completion_rate = round(
        clamp(45 + (overall_score - 70) * 0.8 + rng.uniform(-6, 6), 20, 98) / 100,
        3,
    )
    retention_3s = round(
        clamp(52 + hook_score * 0.35 + rng.uniform(-5, 5), 25, 99) / 100,
        3,
    )
    return {
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "completion_rate": completion_rate,
        "retention_3s": retention_3s,
    }


def compute_real_score(metrics):
    views = int(metrics.get("views") or 0)
    likes = int(metrics.get("likes") or 0)
    comments = int(metrics.get("comments") or 0)
    shares = int(metrics.get("shares") or 0)
    completion_rate = float(metrics.get("completion_rate") or 0.0)
    retention_3s = float(metrics.get("retention_3s") or 0.0)

    views_score = clamp(min(100, (views + 1) ** 0.25 / 10 * 100))
    completion_score = clamp(completion_rate * 100)
    retention_score = clamp(retention_3s * 100)
    interactions = likes + comments * 2 + shares * 3
    interaction_rate = interactions / views * 100 if views > 0 else 0.0
    interaction_score = clamp(interaction_rate * 20)
    real_score = clamp(
        0.35 * completion_score
        + 0.25 * retention_score
        + 0.25 * interaction_score
        + 0.15 * views_score
    )
    return real_score, round(interaction_rate, 3)


def build_recommendations(prediction_score, real_score, metrics):
    recommendations = []
    difference = round(prediction_score - real_score, 2)
    completion_rate = float(metrics.get("completion_rate") or 0.0)
    retention_3s = float(metrics.get("retention_3s") or 0.0)
    views = int(metrics.get("views") or 0)
    likes = int(metrics.get("likes") or 0)
    comments = int(metrics.get("comments") or 0)
    shares = int(metrics.get("shares") or 0)
    interaction_rate = (likes + comments * 2 + shares * 3) / views * 100 if views > 0 else 0.0

    if retention_3s < 0.6:
        recommendations.append("前3秒留存偏低，强化开场冲突与悬念")
    if completion_rate < 0.5:
        recommendations.append("完播率偏低，压缩拖沓镜头并加快节奏")
    if interaction_rate < 3:
        recommendations.append("互动率偏低，增加提问或争议性结尾引导评论")
    if views < 1000:
        recommendations.append("播放量基数小，优化标题关键词与封面信息量")
    if difference > 10:
        recommendations.append("预测高于实际，检查标题/封面与内容是否匹配")
    elif difference < -10:
        recommendations.append("实际表现超出预测，复盘爆款因子并复用到下一集")
    if not recommendations:
        recommendations.append("各项指标均衡，保持当前制作标准并继续迭代")
    return recommendations[:6]


class AnalyticsAgent:
    def __init__(self, run_id, output_dir, db_path, logger):
        self.run_id = run_id
        self.output_dir = Path(output_dir)
        self.db_path = db_path
        self.logger = logger

    def run(self, content_score, platform_data=None, force_simulate=False):
        self.output_dir.mkdir(parents=True, exist_ok=True)
        report_path = self.output_dir / "analytics_report.json"
        existing = db.get_score_accuracy(self.db_path, self.run_id)
        if (
            existing
            and existing["status"] == "done"
            and existing["report_path"]
            and Path(existing["report_path"]).exists()
        ):
            self.logger.info("analytics report already done, skip")
            return json.loads(existing["report_json"])

        prediction_score = int(content_score.get("overall_score") or 0)
        hook_score = int(content_score.get("hook_score") or 0)
        source = "real"
        if platform_data is None or force_simulate:
            platform_data = simulate_platform_data(self.run_id, prediction_score, hook_score)
            source = "simulated"
        real_score, interaction_rate = compute_real_score(platform_data)
        difference = round(prediction_score - real_score, 2)
        recommendations = build_recommendations(prediction_score, real_score, platform_data)
        report = {
            "prediction_score": prediction_score,
            "real_score": real_score,
            "difference": difference,
            "recommendations": recommendations,
            "source": source,
            "metrics": {
                "views": int(platform_data.get("views") or 0),
                "likes": int(platform_data.get("likes") or 0),
                "comments": int(platform_data.get("comments") or 0),
                "shares": int(platform_data.get("shares") or 0),
                "completion_rate": float(platform_data.get("completion_rate") or 0.0),
                "retention_3s": float(platform_data.get("retention_3s") or 0.0),
                "interaction_rate": interaction_rate,
            },
        }
        try:
            db.upsert_video_metrics(
                self.db_path,
                self.run_id,
                source,
                views=int(platform_data.get("views") or 0),
                likes=int(platform_data.get("likes") or 0),
                comments=int(platform_data.get("comments") or 0),
                shares=int(platform_data.get("shares") or 0),
                completion_rate=float(platform_data.get("completion_rate") or 0.0),
                retention_3s=float(platform_data.get("retention_3s") or 0.0),
                interaction_rate=interaction_rate,
                real_score=real_score,
            )
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            db.upsert_score_accuracy(
                self.db_path,
                self.run_id,
                "done",
                prediction_score=prediction_score,
                real_score=real_score,
                difference=difference,
                report_path=str(report_path),
                recommendations=json.dumps(recommendations, ensure_ascii=False),
                report_json=json.dumps(report, ensure_ascii=False),
            )
        except Exception as e:
            db.upsert_score_accuracy(
                self.db_path,
                self.run_id,
                "failed",
                error=str(e),
            )
            raise
        self.logger.info(
            "analytics done: prediction=%s real=%s diff=%s source=%s",
            prediction_score,
            real_score,
            difference,
            source,
        )
        return report
