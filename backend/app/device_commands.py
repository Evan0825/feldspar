"""Shared durable device-command acknowledgement logic."""
from __future__ import annotations

from datetime import datetime

from app.agent.candidates import approve_candidate
from app.database import (
    acknowledge_device_command,
    commit_manual_config_command,
    get_device_command,
    set_light_state,
    set_sound_state,
    upsert_device,
)


def _config_matches(expected: dict, actual: dict) -> bool:
    if not isinstance(expected, dict) or not isinstance(actual, dict):
        return False
    for key, expected_value in expected.items():
        if key not in actual:
            return False
        actual_value = actual[key]
        if isinstance(expected_value, dict):
            if not _config_matches(expected_value, actual_value):
                return False
        elif actual_value != expected_value:
            return False
    return True


def finalize_device_command_ack(
    *,
    device_id: str,
    command_id: str,
    status: str,
    readback: dict | None = None,
    error_code: str = "",
) -> dict:
    """Persist one device ACK and commit state only for matching command kinds."""
    readback = readback if isinstance(readback, dict) else {}
    command = get_device_command(command_id)
    if not command or command.get("device_id") != device_id:
        raise ValueError("DEVICE_COMMAND_NOT_FOUND")

    final_status = status
    final_error_code = error_code
    if command.get("status") in {"applied", "rejected", "failed", "readback-mismatch", "expired"}:
        return command

    if command["command_type"] in {"stop_all", "stop_intervention"} and status == "applied":
        stopped = type(readback.get("vibration_level")) is int and readback["vibration_level"] == 0
        if command["command_type"] == "stop_all":
            stopped = stopped and readback.get("stop_latched") is True and readback.get("outputs_stopped") is True
        if not stopped:
            final_status = "readback-mismatch"
            final_error_code = "STOP_READBACK_MISMATCH"
    elif command["command_type"] in {"apply_config", "apply_manual_config"} and status == "applied":
        expected = command["payload"].get("settings") or {}
        readback_config = readback.get("config") if isinstance(readback, dict) else None
        target_version = int(command["payload"].get("target_config_version") or 0)
        readback_version = int(readback.get("config_version") or 0)
        expected_mode = command["payload"].get("mode")
        readback_mode = readback.get("mode") if isinstance(readback, dict) else None
        mode_mismatch = (
            command["command_type"] == "apply_manual_config"
            and expected_mode in {"solo", "partner"}
            and readback_mode != expected_mode
        )
        if (
            not _config_matches(expected, readback_config)
            or readback_version != target_version
            or mode_mismatch
        ):
            final_status = "readback-mismatch"
            final_error_code = "READBACK_MISMATCH"
        elif command["command_type"] == "apply_config":
            candidate_id = command["payload"].get("candidate_id")
            applied = approve_candidate(candidate_id, command["idempotency_key"])
            if applied.get("status") != "applied":
                final_status = "failed"
                final_error_code = "CONFIG_COMMIT_FAILED"
        else:
            persisted = commit_manual_config_command(
                device_id=device_id,
                command_id=command_id,
                expected_version=command["expected_config_version"],
                settings=expected,
                mode=command["payload"].get("mode") or "solo",
                readback=readback,
            )
            upsert_device(device_id, last_online=int(datetime.now().timestamp()))
            return persisted
    elif command["command_type"] in {"set_sound", "set_light"} and status == "applied":
        state_key = "sound" if command["command_type"] == "set_sound" else "light"
        expected = command["payload"].get(state_key) or {}
        actual = readback.get(state_key) if isinstance(readback, dict) else None
        if not _config_matches(expected, actual):
            final_status = "readback-mismatch"
            final_error_code = "READBACK_MISMATCH"
        elif state_key == "sound":
            set_sound_state(device_id, command["payload"].get("patch") or {})
        else:
            set_light_state(device_id, command["payload"].get("patch") or {})

    persisted = acknowledge_device_command(
        device_id=device_id,
        command_id=command_id,
        status=final_status,
        readback=readback,
        error_code=final_error_code,
    )
    upsert_device(device_id, last_online=int(datetime.now().timestamp()))
    return persisted
