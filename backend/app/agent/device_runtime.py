"""Hardware-independent reference runtime for the local intervention loop.

The ESP32 firmware should port this orchestration while replacing SensorFrame
production, Actuator methods, event upload, command polling and snapshot upload
with device-specific drivers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, Optional, Protocol
import time
import uuid
from zoneinfo import ZoneInfo

from app.agent.engine import SnoozMateAgent
from app.agent.safety import validate_agent_config
from app.audio.snore_detector import RuleBasedSnoreDetector
from app.config import DEFAULT_AGENT_CONFIG, NIGHT_END_HOUR, NIGHT_START_HOUR, NIGHT_TIMEZONE


@dataclass(frozen=True)
class SensorFrame:
    timestamp: float
    audio_confidence: float
    in_bed: bool
    body_motion_level: float
    temperature_ok: bool = True
    is_partner: Optional[bool] = None
    elapsed_seconds: float = 1.0
    mic_status: str = "ready"
    radar_status: str = "ready"
    pad_status: str = "connected"


class Actuator(Protocol):
    def set_vibration_level(self, level: int) -> None: ...
    def stop_vibration(self) -> None: ...


class MemoryActuator:
    """Test/reference actuator. Production firmware must replace this driver."""

    def __init__(self):
        self.level = 0
        self.history = []

    def set_vibration_level(self, level: int) -> None:
        self.level = int(level)
        self.history.append(("vibrate", self.level))

    def stop_vibration(self) -> None:
        if self.level:
            self.history.append(("stop", self.level))
        self.level = 0


class LocalInterventionRuntime:
    """Runs the safety-critical loop locally and uploads only structured data."""

    def __init__(
        self,
        device_id: str,
        actuator: Actuator,
        config: Optional[dict] = None,
        config_version: int = 0,
        mode: str = "solo",
        firmware_version: str = "reference-runtime-v1",
        load_state: Optional[Callable[[], dict]] = None,
        save_state: Optional[Callable[[dict], None]] = None,
        snore_detector: Optional[RuleBasedSnoreDetector] = None,
    ):
        self.device_id = device_id
        self.actuator = actuator
        self.config = {**DEFAULT_AGENT_CONFIG, **(config or {})}
        self.agent = SnoozMateAgent(self.config, device_id)
        self.config_version = max(0, int(config_version))
        self.mode = "partner" if mode == "partner" else "solo"
        self.agent.state.partner_mode = self.mode == "partner"
        self.session_id = f"session_{uuid.uuid4().hex[:16]}"
        self.current_night_id = ""
        self._save_state = save_state
        restored = load_state() if load_state else {}
        if restored and "agent_state" in restored:
            self.config = {**self.config, **(restored.get("config") or {})}
            self.agent.config = dict(self.config)
            self.agent.restore_state(restored.get("agent_state") or {})
            self.config_version = max(
                self.config_version,
                int(restored.get("config_version") or 0),
            )
            self.mode = "partner" if restored.get("mode") == "partner" else self.mode
            self.session_id = str(restored.get("session_id") or self.session_id)
            self.current_night_id = str(restored.get("current_night_id") or "")
            self.event_queue = [
                dict(event)
                for event in (restored.get("event_queue") or [])
                if isinstance(event, dict)
            ]
        else:
            self.agent.restore_state(restored or {})
            self.event_queue = []
        self.firmware_version = firmware_version
        self.snore_detector = snore_detector or RuleBasedSnoreDetector()
        self.last_frame: Optional[SensorFrame] = None
        self.last_action = "NONE"
        self._last_persist_monotonic = 0.0

    def _persist(self, force: bool = False):
        if not self._save_state:
            return
        now = time.monotonic()
        if not force and now - self._last_persist_monotonic < 5:
            return
        self._save_state({
            "agent_state": self.agent.export_state(),
            "event_queue": self.pending_events(),
            "config": dict(self.config),
            "config_version": self.config_version,
            "mode": self.mode,
            "session_id": self.session_id,
            "current_night_id": self.current_night_id,
        })
        self._last_persist_monotonic = now

    def tick(self, frame: SensorFrame) -> dict:
        self.last_frame = frame
        frame_night_id = self._night_id(frame.timestamp)
        if frame.in_bed and frame_night_id and frame_night_id != self.current_night_id:
            self.actuator.stop_vibration()
            self.agent.reset_night()
            self.current_night_id = frame_night_id
        previous_state = self.agent.state.state
        decision = self.agent.process_tick(
            audio_confidence=frame.audio_confidence,
            in_bed=frame.in_bed,
            body_motion_level=frame.body_motion_level,
            temp_ok=frame.temperature_ok,
            hardware_ready=(
                frame.mic_status == "ready"
                and frame.radar_status == "ready"
                and frame.pad_status == "connected"
            ),
            is_partner=(
                frame.is_partner
                if frame.is_partner is not None
                else self.mode == "partner"
            ),
            elapsed_seconds=frame.elapsed_seconds,
            now=frame.timestamp,
        )
        action = decision["action"]
        if action.startswith("VIBRATE_L"):
            self.actuator.set_vibration_level(decision["level"])
        else:
            # Non-actuation results must never latch the previous output.
            self.actuator.stop_vibration()
        self.last_action = action
        new_events = self.agent.drain_events()
        self.event_queue.extend(new_events)
        self._persist(force=bool(new_events) or previous_state != self.agent.state.state)
        return decision

    def tick_audio(
        self,
        audio_frame,
        *,
        timestamp: float,
        in_bed: bool,
        body_motion_level: float,
        temperature_ok: bool = True,
        is_partner: Optional[bool] = None,
        elapsed_seconds: float = 1.0,
        mic_status: str = "ready",
        radar_status: str = "ready",
        pad_status: str = "connected",
    ) -> dict:
        """Convert one local audio frame to confidence, then run the safety loop."""
        is_snore, confidence, features = self.snore_detector.detect(audio_frame)
        decision = self.tick(
            SensorFrame(
                timestamp=timestamp,
                audio_confidence=confidence,
                in_bed=in_bed,
                body_motion_level=body_motion_level,
                temperature_ok=temperature_ok,
                is_partner=is_partner,
                elapsed_seconds=elapsed_seconds,
                mic_status=mic_status,
                radar_status=radar_status,
                pad_status=pad_status,
            )
        )
        return {
            **decision,
            "is_snore": is_snore,
            "audio_features": features,
        }

    def apply_command(self, command: dict) -> dict:
        """Apply one durable cloud command and return its ACK payload."""
        command_type = command.get("type") or command.get("command_type")
        payload = command.get("payload") or {}
        if command_type == "stop_intervention":
            self.actuator.stop_vibration()
            self.agent.force_stop("用户通过小程序停止")
            self.event_queue.extend(self.agent.drain_events())
            self._persist(force=True)
            return {
                "status": "applied",
                "readback": {
                    "state": self.agent.state.state,
                    "vibration_level": 0,
                    "cycle_id": self.agent.state.active_cycle_id,
                },
            }
        if command_type in {"apply_config", "apply_manual_config"}:
            settings = payload.get("settings")
            if not isinstance(settings, dict):
                return {"status": "rejected", "readback": {}, "error_code": "INVALID_CONFIG"}
            expected_version = int(command.get("expected_config_version") or 0)
            target_version = int(payload.get("target_config_version") or expected_version + 1)
            if expected_version != self.config_version:
                if self.config_version == target_version and all(
                    self.config.get(key) == value for key, value in settings.items()
                ):
                    return {
                        "status": "applied",
                        "readback": {
                            "config": dict(self.config),
                            "config_version": self.config_version,
                            "mode": self.mode,
                        },
                    }
                return {
                    "status": "rejected",
                    "readback": {
                        "config": dict(self.config),
                        "config_version": self.config_version,
                        "mode": self.mode,
                    },
                    "error_code": "CONFIG_VERSION_MISMATCH",
                }
            merged = {**self.config, **settings}
            try:
                validate_agent_config(merged)
            except ValueError:
                return {"status": "rejected", "readback": {}, "error_code": "UNSAFE_CONFIG"}
            self.config = merged
            self.agent.config = dict(merged)
            if payload.get("mode") in {"solo", "partner"}:
                self.mode = payload["mode"]
                self.agent.state.partner_mode = self.mode == "partner"
            self.config_version = max(
                self.config_version,
                target_version,
            )
            self._persist(force=True)
            return {
                "status": "applied",
                "readback": {
                    "config": dict(self.config),
                    "config_version": self.config_version,
                    "mode": self.mode,
                },
            }
        return {"status": "rejected", "readback": {}, "error_code": "UNKNOWN_COMMAND"}

    def apply_bootstrap(self, payload: dict) -> None:
        settings = payload.get("config")
        if not isinstance(settings, dict):
            raise ValueError("bootstrap config is required")
        merged = {**DEFAULT_AGENT_CONFIG, **settings}
        validate_agent_config(merged)
        self.config = merged
        self.agent.config = dict(merged)
        self.config_version = max(1, int(payload.get("config_version") or 1))
        self.mode = "partner" if payload.get("mode") == "partner" else "solo"
        self.agent.state.partner_mode = self.mode == "partner"
        self._persist(force=True)

    def drain_events(self) -> list:
        events = self.event_queue
        self.event_queue = []
        self._persist(force=True)
        return events

    def pending_events(self) -> list:
        return [dict(event) for event in self.event_queue]

    def acknowledge_uploaded_events(self, count: int) -> None:
        count = max(0, min(int(count), len(self.event_queue)))
        if count:
            del self.event_queue[:count]
            self._persist(force=True)

    def snapshot(self) -> dict:
        status = self.agent.get_status()
        frame = self.last_frame
        return {
            "sequence": status["sequence"],
            "device_time": int(frame.timestamp if frame else time.time()),
            "night_id": self.current_night_id or (self._night_id(frame.timestamp) if frame else ""),
            "session_id": self.session_id,
            "state": status["state"],
            "cycle_id": status["cycle_id"] or "",
            "active_level": self.actuator.level if hasattr(self.actuator, "level") else status["current_level"],
            "rounds_done": status["rounds_done"],
            "rounds_remaining": status["rounds_remaining"],
            "protection_remaining_seconds": status["protection_remaining_seconds"],
            "audio_confidence": frame.audio_confidence if frame else 0,
            "in_bed": frame.in_bed if frame else False,
            "body_motion_level": frame.body_motion_level if frame else 0,
            "temperature_ok": frame.temperature_ok if frame else True,
            "mic_status": frame.mic_status if frame else "offline",
            "radar_status": frame.radar_status if frame else "offline",
            "pad_status": frame.pad_status if frame else "disconnected",
            "config_version": self.config_version,
            "firmware_version": self.firmware_version,
            "last_action": self.last_action,
            "activities": [
                {
                    "time": item.get("time", ""),
                    "title": item.get("message", ""),
                    "detail": item.get("state", ""),
                }
                for item in status["decisions"][-5:]
            ],
        }

    def _night_id(self, timestamp: float) -> str:
        local = datetime.fromtimestamp(timestamp, ZoneInfo(NIGHT_TIMEZONE))
        if local.hour >= NIGHT_START_HOUR:
            night_date = local.date()
        elif local.hour < NIGHT_END_HOUR:
            night_date = local.date() - timedelta(days=1)
        else:
            return ""
        return f"{night_date:%Y%m%d}_{self.device_id}"
