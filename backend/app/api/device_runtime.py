"""Persistent device runtime telemetry and command acknowledgement APIs."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from app import config
from app.access import require_user_device_access
from app.device_auth import require_device_key
from app.mqtt_service import mqtt_bootstrap_contract
from app.device_commands import finalize_device_command_ack
from app.agent.safety import validate_agent_config
from app.database import (
    create_device_command,
    get_device,
    get_device_command,
    get_device_config,
    get_light_state,
    get_runtime_snapshot,
    get_sound_state,
    poll_device_command,
    requeue_device_command,
    save_runtime_snapshot,
    upsert_device,
)


router = APIRouter(prefix="/api/v1", tags=["device runtime"])


class RuntimeSnapshotIn(BaseModel):
    sequence: int = Field(ge=0)
    device_time: int = Field(default=0, ge=0)
    night_id: str = Field(default="", max_length=256)
    session_id: str = Field(default="", max_length=128)
    state: Literal[
        "STANDBY",
        "MONITORING",
        "CONFIRMING",
        "INTERVENTION",
        "VERIFYING",
        "COOLDOWN",
        "SAFETY_LOCKED",
    ] = "STANDBY"
    cycle_id: str = Field(default="", max_length=128)
    active_level: int = Field(default=0, ge=0, le=5)
    rounds_done: int = Field(default=0, ge=0, le=100)
    rounds_remaining: int = Field(default=0, ge=0, le=100)
    protection_remaining_seconds: int = Field(default=0, ge=0, le=24 * 60 * 60)
    audio_confidence: float = Field(default=0, ge=0, le=1)
    in_bed: Optional[bool] = None
    body_motion_level: Optional[float] = Field(default=None, ge=0, le=1)
    temperature_ok: Optional[bool] = None
    stop_latched: Optional[bool] = None
    mic_status: Literal["ready", "offline", "fault", "calibrating"] = "offline"
    radar_status: Literal["ready", "offline", "fault", "calibrating", "not_installed"] = "offline"
    pad_status: Literal["connected", "disconnected", "fault", "unknown"] = "unknown"
    config_version: int = Field(default=0, ge=0)
    firmware_version: str = Field(default="", max_length=64)
    model_version: str = Field(default="", max_length=64)
    feature_version: str = Field(default="", max_length=64)
    feature_quality_flags: Optional[int] = Field(default=None, ge=0, le=31)
    clock_valid: Optional[bool] = None
    manual_active: bool = False
    last_action: str = Field(default="", max_length=64)
    activities: list[dict] = Field(default_factory=list, max_length=20)
    capabilities: dict = Field(default_factory=dict)


class CommandAckIn(BaseModel):
    status: Literal["applied", "rejected", "failed"]
    readback: dict = Field(default_factory=dict)
    error_code: str = Field(default="", max_length=128)


class StopInterventionIn(BaseModel):
    cycle_id: str = Field(default="", max_length=128)
    snapshot_id: str = Field(default="", max_length=128)


class ManualConfigCommandIn(BaseModel):
    config: dict
    mode: Literal["solo", "partner"]
    expected_config_version: int = Field(ge=1)


class DirectControlCommandIn(BaseModel):
    patch: dict = Field(default_factory=dict)


class OutputsStopIn(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)


def stop_response(command):
    from app.mqtt_service import get_mqtt_service
    published = command["status"] in {"pending", "delivered"} and get_mqtt_service().publish_command(command)
    return {"status": command["status"], "command": command, "published": bool(published)}


@router.post("/device/{device_id}/outputs/stop")
def request_outputs_stop(device_id: str, body: OutputsStopIn, authorization: str = Header(default="")):
    require_user_device_access(authorization, device_id, write=True)
    identity = hashlib.sha256(body.request_id.encode()).hexdigest()[:24]
    command = create_device_command(device_id=device_id, command_type="stop_all",
        payload={"reason": "user_requested"}, idempotency_key=f"stop-all:{device_id}:{identity}", ttl_seconds=60)
    return stop_response(command)


@router.post("/device/{device_id}/runtime/snapshot")
def report_runtime_snapshot(
    device_id: str,
    snapshot: RuntimeSnapshotIn,
    x_device_key: str = Header(default=""),
):
    """Receive a truthful snapshot produced by the local device runtime."""
    require_device_key(device_id, x_device_key)
    payload = snapshot.model_dump()
    stored = save_runtime_snapshot(device_id, payload)
    device_fields = {"last_online": int(datetime.now().timestamp())}
    if snapshot.firmware_version:
        device_fields["firmware_version"] = snapshot.firmware_version
    if snapshot.night_id:
        device_fields["last_night_id"] = snapshot.night_id
    upsert_device(device_id, **device_fields)
    return {"status": "ok", "snapshot": stored}


@router.get("/device/{device_id}/runtime/snapshot")
def read_runtime_snapshot(device_id: str, authorization: str = Header(default="")):
    """Return only device-reported runtime state; never synthesize sensor health."""
    require_user_device_access(authorization, device_id)
    snapshot = get_runtime_snapshot(device_id)
    if not snapshot:
        return {
            "device_id": device_id,
            "available": False,
            "freshness": "missing",
        }
    age_seconds = max(0, int(datetime.now().timestamp()) - int(snapshot.get("received_at") or 0))
    fresh = age_seconds <= config.DEVICE_RUNTIME_TTL_SECONDS
    return {
        **snapshot,
        "available": True,
        "freshness": "fresh" if fresh else "stale",
        "age_seconds": age_seconds,
    }


@router.post("/device/{device_id}/commands/poll")
def poll_command(device_id: str, x_device_key: str = Header(default="")):
    """Physical devices poll this endpoint; delivery is persistent and retryable."""
    require_device_key(device_id, x_device_key)
    command = poll_device_command(device_id)
    upsert_device(device_id, last_online=int(datetime.now().timestamp()))
    if not command:
        return {"device_id": device_id, "command": None}
    return {
        "device_id": device_id,
        "command": {
            "command_id": command["command_id"],
            "type": command["command_type"],
            "payload": command["payload"],
            "expected_config_version": command["expected_config_version"],
            "created_at": command["created_at"],
            "expires_at": command["expires_at"],
            "delivery_count": command["delivery_count"],
        },
    }


@router.get("/device/{device_id}/bootstrap")
def device_bootstrap(device_id: str, x_device_key: str = Header(default="")):
    """Return the cloud-authoritative configuration after a device reboot."""
    require_device_key(device_id, x_device_key)
    device = get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="DEVICE_NOT_FOUND")
    return {
        "device_id": device_id,
        "config": get_device_config(device_id),
        "config_version": int(device.get("config_version") or 1),
        "mode": device.get("mode") or "solo",
        "night_window": {
            "timezone": config.NIGHT_TIMEZONE,
            "start_hour": config.NIGHT_START_HOUR,
            "end_hour": config.NIGHT_END_HOUR,
        },
        "runtime_snapshot_interval_seconds": min(5, config.DEVICE_RUNTIME_TTL_SECONDS),
        "mqtt": mqtt_bootstrap_contract(device_id),
        "mqtt_audio_enabled": mqtt_bootstrap_contract(device_id)["audio_enabled"],
    }


@router.post("/device/{device_id}/settings-command")
def create_manual_settings_command(
    device_id: str,
    body: ManualConfigCommandIn,
    authorization: str = Header(default=""),
):
    require_user_device_access(authorization, device_id, write=True)
    device = get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="DEVICE_NOT_FOUND")
    if int(device.get("config_version") or 0) != body.expected_config_version:
        raise HTTPException(status_code=409, detail="CONFIG_CONFLICT")
    merged = {**get_device_config(device_id), **body.config}
    try:
        validate_agent_config(body.config, allow_partial=True)
        validate_agent_config(merged)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"UNSAFE_CONFIG: {error}") from error
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "device_id": device_id,
                "config": body.config,
                "mode": body.mode,
                "version": body.expected_config_version,
            },
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()[:24]
    command = create_device_command(
        device_id=device_id,
        command_type="apply_manual_config",
        payload={
            "settings": merged,
            "mode": body.mode,
            "target_config_version": body.expected_config_version + 1,
        },
        expected_config_version=body.expected_config_version,
        idempotency_key=f"manual:{fingerprint}",
        ttl_seconds=600,
    )
    if command["status"] in {"expired", "failed", "rejected", "readback-mismatch"}:
        command = requeue_device_command(device_id, command["command_id"], ttl_seconds=600)
    return {"status": command["status"], "command": command}


@router.post("/device/{device_id}/sound-command")
def create_sound_command(
    device_id: str,
    body: DirectControlCommandIn,
    authorization: str = Header(default=""),
):
    require_user_device_access(authorization, device_id, write=True)
    allowed = {"scene", "playing", "volume", "timer"}
    patch = {key: value for key, value in body.patch.items() if key in allowed}
    if not patch:
        raise HTTPException(status_code=400, detail="EMPTY_SOUND_COMMAND")
    if "volume" in patch and not 0 <= int(patch["volume"]) <= 100:
        raise HTTPException(status_code=400, detail="INVALID_SOUND_VOLUME")
    if "scene" in patch and patch["scene"] not in {"sleep", "healing", "work", "reading"}:
        raise HTTPException(status_code=400, detail="INVALID_SOUND_SCENE")
    if "timer" in patch and patch["timer"] not in {15, 30, 60, "all-night"}:
        raise HTTPException(status_code=400, detail="INVALID_SOUND_TIMER")
    desired = {**get_sound_state(device_id), **patch}
    command = create_device_command(
        device_id=device_id,
        command_type="set_sound",
        payload={"patch": patch, "sound": desired},
        ttl_seconds=60,
    )
    return {"status": command["status"], "command": command}


@router.post("/device/{device_id}/light-command")
def create_light_command(
    device_id: str,
    body: DirectControlCommandIn,
    authorization: str = Header(default=""),
):
    require_user_device_access(authorization, device_id, write=True)
    allowed = {"enabled", "mode", "brightness", "color"}
    patch = {key: value for key, value in body.patch.items() if key in allowed}
    if not patch:
        raise HTTPException(status_code=400, detail="EMPTY_LIGHT_COMMAND")
    if "brightness" in patch and not 5 <= int(patch["brightness"]) <= 40:
        raise HTTPException(status_code=400, detail="INVALID_LIGHT_BRIGHTNESS")
    if "color" in patch and patch["color"] not in {"amber", "warm-amber", "warm-yellow"}:
        raise HTTPException(status_code=400, detail="INVALID_LIGHT_COLOR")
    desired = {**get_light_state(device_id), **patch}
    command = create_device_command(
        device_id=device_id,
        command_type="set_light",
        payload={"patch": patch, "light": desired},
        ttl_seconds=60,
    )
    return {"status": command["status"], "command": command}


@router.get("/device/{device_id}/commands/{command_id}")
def read_command(
    device_id: str,
    command_id: str,
    authorization: str = Header(default=""),
):
    require_user_device_access(authorization, device_id)
    command = get_device_command(command_id)
    if not command or command.get("device_id") != device_id:
        raise HTTPException(status_code=404, detail="DEVICE_COMMAND_NOT_FOUND")
    return {"device_id": device_id, "command": command}


@router.post("/device/{device_id}/commands/{command_id}/ack")
def acknowledge_command(
    device_id: str,
    command_id: str,
    ack: CommandAckIn,
    x_device_key: str = Header(default=""),
):
    """Finalize a command only after the physical device returns a readback."""
    require_device_key(device_id, x_device_key)
    command = get_device_command(command_id)
    if not command or command.get("device_id") != device_id:
        raise HTTPException(status_code=404, detail="DEVICE_COMMAND_NOT_FOUND")
    persisted = finalize_device_command_ack(
        device_id=device_id,
        command_id=command_id,
        status=ack.status,
        readback=ack.readback,
        error_code=ack.error_code,
    )
    return {"status": persisted["status"], "command": persisted}


@router.post("/device/{device_id}/intervention/stop")
def request_intervention_stop(
    device_id: str,
    body: Optional[StopInterventionIn] = None,
    authorization: str = Header(default=""),
):
    """Queue a fail-safe stop command; success requires a later device ACK."""
    require_user_device_access(authorization, device_id, write=True)
    body = body or StopInterventionIn()
    identity = body.cycle_id or body.snapshot_id or "active"
    command = create_device_command(
        device_id=device_id,
        command_type="stop_intervention",
        payload={
            "cycle_id": body.cycle_id,
            "snapshot_id": body.snapshot_id,
            "reason": "user_requested",
        },
        idempotency_key=f"stop:{device_id}:{identity}",
        ttl_seconds=60,
    )
    if command["status"] in {"expired", "failed", "rejected", "readback-mismatch"}:
        command = requeue_device_command(device_id, command["command_id"], ttl_seconds=60)
    return stop_response(command)
