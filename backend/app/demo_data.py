"""Explicit, labelled simulated sleep data for the product experience."""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import random
from zoneinfo import ZoneInfo

from app import config
from app.database import (
    compute_daily_summary,
    get_conn,
    get_night_id,
    insert_event,
    upsert_device,
)


SIMULATED_MODEL_VERSION = "simulator_v2"
SIMULATED_NOTE = "simulated-experience-data-v2"
_SIMULATION_MARKERS = ("simulator", "demo", "mock")
_SLEEP_PROFILES = (
    {"bed_minute": 23 * 60 + 18, "duration_minutes": 447, "rounds": 4, "successes": 2},
    {"bed_minute": 22 * 60 + 53, "duration_minutes": 478, "rounds": 3, "successes": 2},
    {"bed_minute": 23 * 60 + 46, "duration_minutes": 421, "rounds": 5, "successes": 3},
    {"bed_minute": 24 * 60 + 8, "duration_minutes": 462, "rounds": 2, "successes": 1},
    {"bed_minute": 23 * 60 + 6, "duration_minutes": 438, "rounds": 4, "successes": 2},
    {"bed_minute": 22 * 60 + 51, "duration_minutes": 496, "rounds": 3, "successes": 2},
    {"bed_minute": 23 * 60 + 29, "duration_minutes": 463, "rounds": 4, "successes": 3},
)


def _is_simulated_version(value: object) -> bool:
    version = str(value or "").lower()
    return any(marker in version for marker in _SIMULATION_MARKERS)


def _existing_event_state(device_id: str) -> tuple[int, bool, set[str], bool]:
    conn = get_conn()
    try:
        rows = [
            dict(row)
            for row in conn.execute(
                "SELECT model_version,night_id,note FROM events WHERE device_id=?",
                (device_id,),
            ).fetchall()
        ]
    finally:
        conn.close()
    return (
        len(rows),
        any(not _is_simulated_version(row["model_version"]) for row in rows),
        {str(row.get("night_id") or "") for row in rows if row.get("night_id")},
        all(
            str(row.get("model_version") or "") == SIMULATED_MODEL_VERSION
            and str(row.get("note") or "") == SIMULATED_NOTE
            for row in rows
        ),
    )


def _delete_stale_simulated_data(device_id: str) -> int:
    """Delete only a simulation-only device history before regenerating it."""
    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """SELECT COUNT(*) AS count FROM events
               WHERE device_id=? AND LOWER(model_version) NOT LIKE '%simulator%'
                 AND LOWER(model_version) NOT LIKE '%demo%'
                 AND LOWER(model_version) NOT LIKE '%mock%'""",
            (device_id,),
        ).fetchone()
        if row and int(row["count"] or 0) > 0:
            conn.rollback()
            raise ValueError("real device data exists")
        old_count_row = conn.execute(
            "SELECT COUNT(*) AS count FROM events WHERE device_id=?",
            (device_id,),
        ).fetchone()
        old_count = int(old_count_row["count"] or 0) if old_count_row else 0
        for table in (
            "events",
            "daily_summaries",
            "morning_feedback",
            "bandit_history",
            "bandit_night_updates",
        ):
            conn.execute(f"DELETE FROM {table} WHERE device_id=?", (device_id,))
        conn.commit()
        return old_count
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _night_events(night_start: datetime, night_index: int, rng: random.Random) -> list[dict]:
    base_timestamp = int(night_start.timestamp())
    profile = _SLEEP_PROFILES[night_index % len(_SLEEP_PROFILES)]
    rounds = profile["rounds"]
    target_successes = profile["successes"]
    duration_minutes = profile["duration_minutes"]
    common = {
        "model_version": SIMULATED_MODEL_VERSION,
        "note": SIMULATED_NOTE,
    }
    events = [
        {
            "timestamp": base_timestamp,
            "event_type": "in_bed",
            "in_bed": True,
            "body_motion_level": 0.12,
            **common,
        },
        {
            "timestamp": base_timestamp + 18 * 60,
            "event_type": "body_motion",
            "in_bed": True,
            "body_motion_level": 0.26,
            **common,
        },
        {
            "timestamp": base_timestamp + int(duration_minutes * 0.54) * 60,
            "event_type": "body_motion",
            "in_bed": True,
            "body_motion_level": round(0.18 + rng.random() * 0.25, 2),
            **common,
        },
    ]
    successful_rounds = set(rng.sample(range(1, rounds + 1), target_successes))
    observation_window = max(120, duration_minutes - 145)
    spacing = observation_window / max(1, rounds)
    for round_number in range(1, rounds + 1):
        event_minute = (
            75
            + spacing * (round_number - 0.5)
            + rng.randint(-14, 14)
        )
        timestamp = base_timestamp + int(event_minute * 60)
        confidence = round(0.66 + rng.random() * 0.21, 2)
        duration = round(8 + rng.random() * 17, 1)
        level = 1 if round_number <= 2 else 2
        events.append({
            "timestamp": timestamp,
            "event_type": "snore_detected",
            "snore_confidence": confidence,
            "snore_duration_sec": duration,
            "round_in_night": round_number,
            **common,
        })
        events.append({
            "timestamp": timestamp + 12,
            "event_type": "intervention",
            "vibration_level": level,
            "vibration_duration_ms": 6000 if level == 1 else 8000,
            "round_in_night": round_number,
            **common,
        })
        if round_number in successful_rounds:
            response_time = round(10 + rng.random() * 21, 1)
            events.append({
                "timestamp": timestamp + 12 + int(response_time),
                "event_type": "position_change",
                "round_in_night": round_number,
                "result": "success",
                "response_time_sec": response_time,
                **common,
            })
    events.append({
        "timestamp": base_timestamp + duration_minutes * 60,
        "event_type": "wake_up",
        "in_bed": False,
        **common,
    })
    return events


def seed_simulated_experience_data(device_id: str, days: int = 7) -> dict:
    """Seed a repeatable completed-night dataset without overwriting real data."""
    device_id = str(device_id or "").strip()
    days = max(1, min(int(days), 7))
    if not device_id:
        raise ValueError("device_id is required")

    (
        existing_events,
        has_real_events,
        existing_night_ids,
        current_generation,
    ) = _existing_event_state(device_id)
    if has_real_events:
        return {
            "seeded": False,
            "reason": "real_device_data_exists",
            "existing_events": existing_events,
        }
    timezone = ZoneInfo(config.NIGHT_TIMEZONE)
    latest_completed_night = datetime.now(timezone).date() - timedelta(days=1)
    expected_latest_night = f"{latest_completed_night:%Y%m%d}_{device_id}"
    expected_night_ids = {
        f"{latest_completed_night - timedelta(days=offset):%Y%m%d}_{device_id}"
        for offset in range(days)
    }
    if (
        existing_events
        and current_generation
        and existing_night_ids == expected_night_ids
    ):
        return {
            "seeded": False,
            "reason": "simulated_data_current",
            "existing_events": existing_events,
            "latest_night_id": expected_latest_night,
        }

    replaced_events = _delete_stale_simulated_data(device_id) if existing_events else 0
    seed = int.from_bytes(
        hashlib.sha256(f"{device_id}:{latest_completed_night.isoformat()}".encode()).digest()[:8],
        "big",
    )
    rng = random.Random(seed)
    upsert_device(device_id, last_online=int(datetime.now(timezone).timestamp()))
    night_ids: set[str] = set()
    inserted = 0
    for offset in range(days - 1, -1, -1):
        night_date = latest_completed_night - timedelta(days=offset)
        profile = _SLEEP_PROFILES[days - 1 - offset]
        minute_of_day = profile["bed_minute"]
        start_date = night_date + timedelta(days=minute_of_day // (24 * 60))
        minute_of_day %= 24 * 60
        start = datetime(
            start_date.year,
            start_date.month,
            start_date.day,
            minute_of_day // 60,
            minute_of_day % 60,
            tzinfo=timezone,
        )
        for event in _night_events(start, days - 1 - offset, rng):
            event["device_id"] = device_id
            night_id = get_night_id(device_id, event["timestamp"])
            event["night_id"] = night_id
            insert_event(event)
            inserted += 1
            if night_id:
                night_ids.add(night_id)
    for night_id in sorted(night_ids):
        compute_daily_summary(device_id, night_id)
    return {
        "seeded": True,
        "refreshed": replaced_events > 0,
        "replaced_events": replaced_events,
        "device_id": device_id,
        "days": days,
        "inserted_events": inserted,
        "night_ids": sorted(night_ids),
        "latest_night_id": expected_latest_night,
        "data_source": "simulated",
    }


def refresh_stale_simulated_experience_data(limit: int = 20) -> dict:
    """Refresh old simulation-only devices after a deployment restart."""
    if not config.ALLOW_SIMULATED_EXPERIENCE_DATA:
        return {"checked": 0, "refreshed": 0, "devices": []}
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT device_id,
                      SUM(CASE
                            WHEN LOWER(model_version) LIKE '%simulator%'
                              OR LOWER(model_version) LIKE '%demo%'
                              OR LOWER(model_version) LIKE '%mock%'
                            THEN 0 ELSE 1
                          END) AS real_count
               FROM events
               GROUP BY device_id
               LIMIT ?""",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
    finally:
        conn.close()
    candidates = [
        str(row["device_id"])
        for row in rows
        if int(row["real_count"] or 0) == 0
    ]
    refreshed = []
    for device_id in candidates:
        result = seed_simulated_experience_data(device_id, 7)
        if result.get("refreshed"):
            refreshed.append({
                "device_id": device_id,
                "latest_night_id": result.get("latest_night_id"),
                "replaced_events": result.get("replaced_events", 0),
            })
    return {
        "checked": len(candidates),
        "refreshed": len(refreshed),
        "devices": refreshed,
    }
