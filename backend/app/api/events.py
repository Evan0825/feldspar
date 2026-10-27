"""
事件上报 API —— 设备 → 云端
对应时序图第 ④ 阶段：Wi-Fi 增量上传结构化事件
"""
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

from app.models.schemas import EventIn
from app.audio.feature_contract import FeatureWindow
from app.access import require_user_device_access
from app.device_auth import require_device_key
from app.database import (
    insert_event, insert_events_batch, get_recent_events, upsert_device, get_night_id,
    get_latest_night_id,
    compute_daily_summary, get_daily_summary,
)

router = APIRouter(prefix="/api/v1", tags=["events"])


@router.post("/device/{device_id}/features")
def report_features(device_id: str, window: FeatureWindow, x_device_key: str = Header(default="")):
    require_device_key(device_id, x_device_key)
    if window.device_id != device_id:
        raise HTTPException(status_code=400, detail="feature device_id mismatch")
    from app.mqtt_service import get_mqtt_service
    return get_mqtt_service().ingest_features(device_id, window.model_dump_json().encode())


@router.get("/device/{device_id}/features/latest")
def latest_features(device_id: str, authorization: str = Header(default="")):
    require_user_device_access(authorization, device_id)
    from app.database import get_feature_snapshot
    return get_feature_snapshot(device_id)


class EventBatchIn(BaseModel):
    """批量上传（增量同步）"""
    device_id: str
    night_id: Optional[str] = ""
    events: List[EventIn]
    since_id: Optional[int] = 0  # 增量同步用
    idempotency_key: Optional[str] = ""  # 幂等键（整批）


@router.post("/events")
def report_event(event: EventIn, x_device_key: str = Header(default="")):
    """单条事件上报"""
    if not event.device_id or not event.device_id.strip():
        raise HTTPException(status_code=400, detail="device_id 不能为空")
    require_device_key(event.device_id, x_device_key)
    if event.timestamp is None:
        event.timestamp = int(datetime.now().timestamp())
    # Night membership is derived from the timestamp on the server. This keeps
    # daytime diagnostics out of sleep reports even if a client sends a night_id.
    event.night_id = get_night_id(event.device_id, event.timestamp)

    upsert_device(event.device_id, last_online=int(datetime.now().timestamp()))
    event_id = insert_event(event.model_dump())

    if event_id == 0:
        return {
            "status": "duplicate",
            "event_id": 0,
            "night_id": event.night_id,
            "night_event": bool(event.night_id),
        }

    # Any event can alter a round's outcome (e.g. a later position_change).
    if event.night_id and (event.round_in_night or event.event_type in ("intervention", "position_change", "vibration_stop")):
        compute_daily_summary(event.device_id, event.night_id)

    return {
        "status": "ok",
        "event_id": event_id,
        "night_id": event.night_id,
        "night_event": bool(event.night_id),
    }


@router.post("/events/batch")
def report_events_batch(batch: EventBatchIn, x_device_key: str = Header(default="")):
    """批量增量上传"""
    if not batch.events:
        return {"status": "ok", "inserted": 0, "duplicates": 0}
    if len(batch.events) > 500:
        raise HTTPException(status_code=400, detail="events 单批最多 500 条")
    if not batch.device_id.strip():
        raise HTTPException(status_code=400, detail="device_id 不能为空")
    require_device_key(batch.device_id, x_device_key)

    device_id = batch.device_id
    now_ts = int(datetime.now().timestamp())
    normalized = []
    for idx, event in enumerate(batch.events):
        payload = event.model_dump()
        payload["device_id"] = device_id
        if event.timestamp is None:
            payload["timestamp"] = now_ts + idx
        # Always derive the bucket per event. A single batch can contain events
        # from both sides of midnight, and daytime diagnostics stay unbucketed.
        payload["night_id"] = get_night_id(device_id, payload["timestamp"])
        normalized.append(payload)
    inserted, duplicates, night_ids = insert_events_batch(normalized)

    upsert_device(device_id, last_online=int(datetime.now().timestamp()))

    for derived_night_id in night_ids:
        compute_daily_summary(device_id, derived_night_id)

    return {
        "status": "ok",
        "inserted": inserted,
        "duplicates": duplicates,
        "night_id": next(iter(night_ids)) if len(night_ids) == 1 else "",
        "night_ids": sorted(night_ids),
        "excluded_daytime": sum(1 for event in normalized if not event["night_id"]),
    }


@router.get("/events/{device_id}")
def list_events(
    device_id: str,
    limit: int = 100,
    night_id: str = "",
    authorization: str = Header(default=""),
):
    """获取最近一晚事件，避免默认跨夜返回原始记录。"""
    require_user_device_access(authorization, device_id)
    night_id = night_id or get_latest_night_id(device_id)
    events = get_recent_events(device_id, limit, night_id)
    return {"device_id": device_id, "night_id": night_id, "count": len(events), "events": events}


@router.get("/events/{device_id}/night/{night_id}")
def get_night_event_list(
    device_id: str,
    night_id: str,
    authorization: str = Header(default=""),
):
    """获取某一夜的完整事件"""
    require_user_device_access(authorization, device_id)
    from app.database import get_night_events
    events = get_night_events(device_id, night_id)
    summary = get_daily_summary(device_id, night_id)
    return {"night_id": night_id, "count": len(events), "events": events, "summary": summary}
