"""MQTT realtime audio uplink, analysis, and bounded intervention publishing."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import queue
import re
import socket
import ssl
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import numpy as np
import requests

from app import config
from app.audio.snore_detector import RuleBasedSnoreDetector
from app.audio.feature_contract import FeatureTracker, FeatureWindow
from app.database import (
    count_device_commands,
    create_device_command,
    device_owner_allows_raw_candidate_audio,
    get_runtime_snapshot,
    get_night_id,
    insert_event,
    requeue_device_command,
    save_runtime_snapshot,
    save_feature_snapshot,
    poll_device_command,
    upsert_device,
)
from app.device_commands import finalize_device_command_ack
from app.mqtt_topics import device_topic, parse_device_topic, topic_prefix

logger = logging.getLogger("snoozmate.mqtt")

ESP32_MQTT_COMMAND_MAX_BYTES = 1024
ESP32_MQTT_COMMAND_PAYLOAD_MAX_BYTES = 480


def _json_ready(value):
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, tuple):
        return [_json_ready(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def _fast_rule_audio_analysis(samples: np.ndarray, sample_rate: int) -> tuple[float, dict]:
    """Bounded DSP analysis; periodicity runs on a short energy envelope, not raw O(n^2) audio."""
    if samples.size < max(800, sample_rate // 2):
        return 0.0, {"reason": "window_too_short"}
    signal = np.asarray(samples, dtype=np.float32)
    signal = signal - float(np.mean(signal))
    rms = float(np.sqrt(np.mean(signal * signal) + 1e-12))

    block_size = max(1, int(sample_rate * 0.02))
    block_count = signal.size // block_size
    if block_count < 16:
        return 0.0, {"reason": "envelope_too_short", "rms": rms}
    blocks = signal[: block_count * block_size].reshape(block_count, block_size)
    envelope = np.sqrt(np.mean(blocks * blocks, axis=1) + 1e-12)
    noise_floor = float(max(np.percentile(envelope, 20), 1e-5))
    volume_ratio = rms / noise_floor
    volume_score = float(np.clip((volume_ratio - 1.2) / 2.8, 0, 1))

    window = np.hanning(signal.size).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(signal * window)) ** 2
    frequencies = np.fft.rfftfreq(signal.size, 1.0 / sample_rate)
    total_energy = float(np.sum(spectrum[1:]) + 1e-12)
    band_mask = (frequencies >= 100) & (frequencies <= 850)
    band_ratio = float(np.sum(spectrum[band_mask]) / total_energy)
    spectrum_score = float(np.clip((band_ratio - 0.30) / 0.40, 0, 1))

    centered = envelope - float(np.mean(envelope))
    autocorrelation = np.correlate(centered, centered, mode="full")[block_count - 1 :]
    zero_lag = float(autocorrelation[0] + 1e-12)
    envelope_rate = sample_rate / block_size
    min_lag = max(1, int(envelope_rate / 2.5))
    max_lag = min(block_count - 1, int(envelope_rate / 0.5))
    if max_lag > min_lag:
        periodicity = float(np.max(autocorrelation[min_lag : max_lag + 1]) / zero_lag)
    else:
        periodicity = 0.0
    periodicity = float(np.clip(periodicity, 0, 1))

    confidence = float(np.clip(
        0.35 * spectrum_score + 0.35 * periodicity + 0.25 * volume_score + 0.05,
        0,
        1,
    ))
    return confidence, {
        "rms": round(rms, 6),
        "noise_floor": round(noise_floor, 6),
        "volume_ratio": round(volume_ratio, 3),
        "snore_band_ratio": round(band_ratio, 4),
        "periodicity": round(periodicity, 4),
        "window_samples": int(signal.size),
    }

def mqtt_audio_policy() -> dict:
    return {
        "mqtt_audio_enabled": bool(config.MQTT_ENABLED and config.MQTT_AUDIO_ENABLED),
        "sample_rate_hz": config.MQTT_AUDIO_SAMPLE_RATE,
        "codec": "pcm_s16le",
        "channels": 1,
        "chunk_ms": config.MQTT_AUDIO_CHUNK_MS,
        "frame_samples": config.MQTT_AUDIO_FRAME_SAMPLES,
        "analysis_window_seconds": config.MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS,
        "max_capture_seconds": config.MQTT_AUDIO_MAX_CAPTURE_SECONDS,
        "max_payload_bytes": config.MQTT_AUDIO_MAX_PAYLOAD_BYTES,
        "qos": config.MQTT_QOS,
        "topic_prefix": topic_prefix(),
    }


def raw_candidate_audio_allowed(device_id: str) -> bool:
    return bool(
        config.RAW_CANDIDATE_AUDIO_ENABLED
        and device_owner_allows_raw_candidate_audio(device_id)
    )


def mqtt_bootstrap_contract(device_id: str) -> dict:
    audio_allowed = bool(config.MQTT_AUDIO_ENABLED and raw_candidate_audio_allowed(device_id))
    return {
        "enabled": bool(config.MQTT_ENABLED and config.MQTT_BROKER_HOST),
        "audio_enabled": audio_allowed,
        "host": config.MQTT_BROKER_HOST or "",
        "port": config.MQTT_BROKER_PORT,
        "tls_enabled": config.MQTT_TLS_ENABLED,
        "username": device_id,
        "password_source": "device_key",
        "qos": config.MQTT_QOS,
        "topic_prefix": topic_prefix(),
        "topics": {
            "audio_up": device_topic(device_id, "audio", "up"),
            "features_up": device_topic(device_id, "features", "up"),
            "telemetry_up": device_topic(device_id, "telemetry", "up"),
            "acks_up": device_topic(device_id, "acks", "up"),
            "commands_down": device_topic(device_id, "commands", "down"),
        },
        "policy": {
            **mqtt_audio_policy(),
            "raw_candidate_audio_allowed": audio_allowed,
            "raw_candidate_audio_requires_owner_consent": True,
            "raw_candidate_audio_consent_version": config.RAW_CANDIDATE_AUDIO_CONSENT_VERSION,
        },
    }


@dataclass
class AudioWindowResult:
    device_id: str
    session_id: str
    sequence_start: int
    sequence_end: int
    timestamp_ms: int
    duration_seconds: float
    confidence: float
    source: str
    detector_features: dict = field(default_factory=dict)
    external_metadata: dict = field(default_factory=dict)


@dataclass
class AudioBufferState:
    session_id: str
    detector: RuleBasedSnoreDetector
    sequence_start: int = 0
    sequence_end: int = 0
    last_sequence: int = -1
    first_timestamp_ms: int = 0
    last_timestamp_ms: int = 0
    pcm_parts: list[bytes] = field(default_factory=list)
    sample_count: int = 0

    def clear(self) -> None:
        self.sequence_start = 0
        self.sequence_end = 0
        self.first_timestamp_ms = 0
        self.last_timestamp_ms = 0
        self.pcm_parts = []
        self.sample_count = 0


@dataclass
class CloudDecisionState:
    confirm_hits: int = 0
    last_command_at: int = 0
    last_decision_id: str = ""
    last_published_command_id: str = ""


class ExternalAudioModelClient:
    """Optional external audio confidence hook; rule-based DSP remains the fallback."""

    @staticmethod
    def _pcm_wav_base64(pcm_bytes: bytes, sample_rate: int) -> str:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_bytes)
        return base64.b64encode(output.getvalue()).decode("ascii")

    @staticmethod
    def _content_text(content) -> str:
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return "".join(
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict)
            ).strip()
        return ""

    @classmethod
    def _confidence_from_chat_response(cls, data: dict) -> tuple[float, dict]:
        choices = data.get("choices") if isinstance(data, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices else {}
        content = message.get("content") if isinstance(message, dict) else ""
        text = cls._content_text(content)
        candidates = []
        if isinstance(data, dict):
            candidates.append(data)
            if isinstance(data.get("result"), dict):
                candidates.append(data["result"])
        if text:
            cleaned = text.replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError:
                match = re.search(r"\{.*\}", cleaned, re.DOTALL)
                parsed = json.loads(match.group(0)) if match else {}
            if isinstance(parsed, dict):
                candidates.append(parsed)
        for candidate in candidates:
            for key in ("confidence", "snore_confidence", "snore_probability", "probability"):
                if key in candidate:
                    confidence = float(candidate[key])
                    if 0 <= confidence <= 1:
                        return confidence, {"response_text": text[:500]}
            if "is_snore" in candidate:
                return (1.0 if bool(candidate["is_snore"]) else 0.0), {"response_text": text[:500]}
        raise ValueError("audio chat response missing confidence")

    def _analyze_volcengine_chat(
        self,
        *,
        device_id: str,
        session_id: str,
        sequence_start: int,
        sequence_end: int,
        timestamp_ms: int,
        sample_rate: int,
        pcm_bytes: bytes,
    ) -> dict:
        audio_b64 = self._pcm_wav_base64(pcm_bytes, sample_rate)
        instruction = (
            "Analyze this short sleep audio window for probable snoring. "
            "Return JSON only: {\"confidence\": number from 0 to 1, "
            "\"is_snore\": boolean, \"reason\": short string}. "
            "Do not diagnose a medical condition."
        )
        part_type = config.AUDIO_MODEL_AUDIO_PART_TYPE
        if part_type == "audio_url":
            audio_part = {
                "type": "audio_url",
                "audio_url": {"url": f"data:audio/wav;base64,{audio_b64}"},
            }
        elif part_type == "audio":
            audio_part = {"type": "audio", "audio": audio_b64}
        else:
            audio_part = {
                "type": "input_audio",
                "input_audio": {"data": audio_b64, "format": "wav"},
            }
        payload = {
            "model": config.AUDIO_MODEL_NAME or "auto",
            "messages": [
                {"role": "system", "content": "You are a bounded audio event classifier."},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": instruction},
                        audio_part,
                    ],
                },
            ],
            "temperature": 0,
            "max_tokens": 128,
        }
        url = config.AUDIO_MODEL_URL.rstrip("/")
        if not url.endswith("/chat/completions"):
            url += "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if config.AUDIO_MODEL_KEY:
            headers["Authorization"] = f"Bearer {config.AUDIO_MODEL_KEY}"
        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=config.AUDIO_MODEL_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
        confidence, metadata = self._confidence_from_chat_response(data)
        return {
            "confidence": confidence,
            "source": "volcengine_auto",
            "metadata": metadata,
            "model": data.get("model") or config.AUDIO_MODEL_NAME or "auto",
        }

    def analyze(
        self,
        *,
        device_id: str,
        session_id: str,
        sequence_start: int,
        sequence_end: int,
        timestamp_ms: int,
        sample_rate: int,
        pcm_bytes: bytes,
    ) -> dict:
        if not config.AUDIO_MODEL_URL:
            return {}
        if config.AUDIO_MODEL_PROTOCOL == "volcengine_chat":
            return self._analyze_volcengine_chat(
                device_id=device_id,
                session_id=session_id,
                sequence_start=sequence_start,
                sequence_end=sequence_end,
                timestamp_ms=timestamp_ms,
                sample_rate=sample_rate,
                pcm_bytes=pcm_bytes,
            )
        payload = {
            "model": config.AUDIO_MODEL_NAME or "",
            "device_id": device_id,
            "session_id": session_id,
            "sequence_start": sequence_start,
            "sequence_end": sequence_end,
            "timestamp_ms": timestamp_ms,
            "codec": "pcm_s16le",
            "sample_rate": sample_rate,
            "channels": 1,
            "audio_b64": base64.b64encode(pcm_bytes).decode("ascii"),
        }
        headers = {"Content-Type": "application/json"}
        if config.AUDIO_MODEL_KEY:
            headers["Authorization"] = f"Bearer {config.AUDIO_MODEL_KEY}"
        response = requests.post(
            config.AUDIO_MODEL_URL,
            json=payload,
            headers=headers,
            timeout=config.AUDIO_MODEL_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
        confidence = data.get("confidence")
        if confidence is None and isinstance(data.get("result"), dict):
            confidence = data["result"].get("confidence")
        if confidence is None:
            raise ValueError("audio model response missing confidence")
        confidence = float(confidence)
        if not 0 <= confidence <= 1:
            raise ValueError("audio model confidence out of range")
        metadata = data.get("metadata")
        return {
            "confidence": confidence,
            "source": "external_audio_model",
            "metadata": metadata if isinstance(metadata, dict) else {},
            "model": data.get("model") or config.AUDIO_MODEL_NAME or "",
        }


class MqttRealtimeService:
    def __init__(
        self,
        *,
        client_factory: Callable[[], object] | None = None,
        audio_model_client: ExternalAudioModelClient | None = None,
        now_fn: Callable[[], float] | None = None,
    ):
        self._client_factory = client_factory or self._build_paho_client
        self._audio_model_client = audio_model_client or ExternalAudioModelClient()
        self._now_fn = now_fn or time.time
        self._client = None
        self._lock = threading.RLock()
        self._started = False
        self._connected = False
        self._subscriptions: list[str] = []
        self._last_error = ""
        self._last_message_error = ""
        self._audio_buffers: dict[str, AudioBufferState] = {}
        self._feature_trackers: dict[str, FeatureTracker] = {}
        self._decisions: dict[str, CloudDecisionState] = {}
        self._message_queue: queue.Queue[tuple[str, bytes] | None] = queue.Queue(
            maxsize=config.MQTT_WORKER_QUEUE_SIZE
        )
        self._worker_stop = threading.Event()
        self._worker_thread: threading.Thread | None = None
        self._worker_enqueued = 0
        self._worker_dropped = 0
        self._worker_processed = 0
        self._worker_failures = 0
        self._last_analysis_ms = 0.0
        self._telemetry_received = 0
        self._audio_frames_received = 0
        self._audio_windows_analyzed = 0
        self._commands_published = 0
        self._acks_received = 0
        self._last_analysis_source = ""
        self._last_analysis_confidence: float | None = None
        self._last_command_type = ""
        self._last_ack_status = ""
        self._last_audio_observation_at: dict[str, int] = {}
        self._audio_observations_persisted = 0
        self._runtime_client_id = self._build_runtime_client_id()
        self._connection_count = 0
        self._last_disconnect_code = None

    @staticmethod
    def _build_runtime_client_id() -> str:
        base = re.sub(r"[^A-Za-z0-9_-]", "-", config.MQTT_CLIENT_ID).strip("-")
        base = base or "snoozmate-cloud-backend"
        if not config.MQTT_CLIENT_ID_PER_INSTANCE:
            return base[:120]
        instance = re.sub(r"[^A-Za-z0-9_-]", "-", socket.gethostname()).strip("-")
        instance = instance[-32:] or "instance"
        return f"{base[:72]}-{instance}-{os.getpid()}"[:120]

    def _now(self) -> int:
        return int(self._now_fn())

    def _now_ms(self) -> int:
        return int(self._now_fn() * 1000)

    def _build_paho_client(self):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as error:
            raise RuntimeError("paho-mqtt is required when SNOOZMATE_MQTT_ENABLED=true") from error
        client = mqtt.Client(client_id=self._runtime_client_id)
        if config.MQTT_USERNAME or config.MQTT_PASSWORD:
            client.username_pw_set(config.MQTT_USERNAME, config.MQTT_PASSWORD)
        if config.MQTT_TLS_ENABLED:
            tls_kwargs = {}
            if config.MQTT_TLS_CA_CERT:
                tls_kwargs["ca_certs"] = config.MQTT_TLS_CA_CERT
            client.tls_set(**tls_kwargs)
            client.tls_insecure_set(config.MQTT_TLS_INSECURE)
        if hasattr(client, "reconnect_delay_set"):
            client.reconnect_delay_set(min_delay=1, max_delay=30)
        return client

    def start(self) -> bool:
        with self._lock:
            if self._started:
                return True
            self._last_error = ""
            self._last_message_error = ""
            if not config.MQTT_ENABLED:
                return False
            if not config.MQTT_BROKER_HOST:
                self._last_error = "missing_broker_host"
                logger.error("MQTT enabled but SNOOZMATE_MQTT_BROKER_HOST is empty")
                return False
            try:
                self._client = self._client_factory()
                self._client.on_connect = self._on_connect
                self._client.on_disconnect = self._on_disconnect
                self._client.on_message = self._on_message
                self._client.connect(
                    config.MQTT_BROKER_HOST,
                    config.MQTT_BROKER_PORT,
                    config.MQTT_KEEPALIVE_SECONDS,
                )
                self._client.loop_start()
                self._worker_stop.clear()
                self._worker_thread = threading.Thread(
                    target=self._worker_loop,
                    name="snoozmate-mqtt-worker",
                    daemon=True,
                )
                self._worker_thread.start()
                self._started = True
                return True
            except (OSError, RuntimeError, ValueError, ssl.SSLError) as error:
                self._client = None
                self._last_error = f"{type(error).__name__}: {error}"
                logger.error("MQTT startup failed: %s", self._last_error)
                return False

    def stop(self) -> None:
        with self._lock:
            client = self._client
            worker = self._worker_thread
            self._client = None
            self._worker_thread = None
            self._started = False
            self._connected = False
            self._subscriptions = []
            self._worker_stop.set()
        try:
            self._message_queue.put_nowait(None)
        except queue.Full:
            pass
        if worker and worker.is_alive():
            worker.join(timeout=3)
        if not client:
            return
        try:
            client.loop_stop()
        finally:
            client.disconnect()

    def status(self) -> dict:
        parsed = urlparse(config.AUDIO_MODEL_URL) if config.AUDIO_MODEL_URL else None
        with self._lock:
            return {
                "enabled": config.MQTT_ENABLED,
                "configured": bool(config.MQTT_BROKER_HOST),
                "started": self._started,
                "connected": self._connected,
                "broker_host": config.MQTT_BROKER_HOST or None,
                "broker_port": config.MQTT_BROKER_PORT,
                "client_id_strategy": (
                    "per_instance" if config.MQTT_CLIENT_ID_PER_INSTANCE else "shared"
                ),
                "tls_enabled": config.MQTT_TLS_ENABLED,
                "topic_prefix": topic_prefix(),
                "qos": config.MQTT_QOS,
                "subscriptions": list(self._subscriptions),
                "active_audio_sessions": len(self._audio_buffers),
                "pending_decision_state_devices": len(self._decisions),
                "last_error": self._last_error or None,
                "connection_count": self._connection_count,
                "last_disconnect_code": self._last_disconnect_code,
                "last_message_error": self._last_message_error or None,
                "worker": {
                    "alive": bool(self._worker_thread and self._worker_thread.is_alive()),
                    "queue_depth": self._message_queue.qsize(),
                    "queue_capacity": config.MQTT_WORKER_QUEUE_SIZE,
                    "enqueued": self._worker_enqueued,
                    "dropped": self._worker_dropped,
                    "processed": self._worker_processed,
                    "failures": self._worker_failures,
                    "last_analysis_ms": round(self._last_analysis_ms, 2),
                },
                "flow": {
                    "telemetry_received": self._telemetry_received,
                    "audio_frames_received": self._audio_frames_received,
                    "audio_windows_analyzed": self._audio_windows_analyzed,
                    "audio_observations_persisted": self._audio_observations_persisted,
                    "commands_published": self._commands_published,
                    "acks_received": self._acks_received,
                    "last_analysis_source": self._last_analysis_source or None,
                    "last_analysis_confidence": self._last_analysis_confidence,
                    "last_command_type": self._last_command_type or None,
                    "last_ack_status": self._last_ack_status or None,
                },
                "device_command_wire_limits": {
                    "envelope_max_bytes": ESP32_MQTT_COMMAND_MAX_BYTES,
                    "payload_max_bytes": ESP32_MQTT_COMMAND_PAYLOAD_MAX_BYTES,
                },
                "audio_enabled": config.MQTT_AUDIO_ENABLED,
                "audio_policy": mqtt_audio_policy(),
                "http_auth_enabled": config.MQTT_HTTP_AUTH_ENABLED,
                "service_account_configured": bool(
                    config.MQTT_SERVICE_USERNAME and config.MQTT_SERVICE_PASSWORD
                ),
                "device_auth": {
                    "mode": (
                        "emqx_http"
                        if config.MQTT_HTTP_AUTH_ENABLED
                        else "broker_static_or_external"
                    ),
                    "dynamic_device_credentials_ready": bool(
                        config.MQTT_HTTP_AUTH_ENABLED
                        and config.MQTT_HTTP_AUTH_SHARED_SECRET
                        and config.MQTT_SERVICE_USERNAME
                        and config.MQTT_SERVICE_PASSWORD
                    ),
                },
                "raw_candidate_audio_globally_enabled": config.RAW_CANDIDATE_AUDIO_ENABLED,
                "external_audio_model": {
                    "configured": bool(config.AUDIO_MODEL_URL),
                    "protocol": config.AUDIO_MODEL_PROTOCOL if config.AUDIO_MODEL_URL else None,
                    "host": parsed.hostname if parsed else None,
                    "model": config.AUDIO_MODEL_NAME or None,
                    "timeout_seconds": config.AUDIO_MODEL_TIMEOUT_SECONDS,
                },
            }

    def ingest_message(self, topic: str, payload_bytes: bytes) -> dict:
        route = parse_device_topic(topic)
        if not route:
            raise ValueError("unsupported topic")
        channel = route["channel"]
        direction = route["direction"]
        if direction != "up":
            raise ValueError("only uplink topics are accepted")
        if channel == "telemetry":
            return self._handle_telemetry(route["device_id"], payload_bytes)
        if channel == "audio":
            return self._handle_audio(route["device_id"], payload_bytes)
        if channel == "features":
            return self.ingest_features(route["device_id"], payload_bytes)
        if channel == "acks":
            return self._handle_ack(route["device_id"], payload_bytes)
        raise ValueError("unsupported uplink channel")

    @staticmethod
    def _compact_cloud_intervention_payload(payload: dict) -> dict:
        """Keep the MQTT actuator command within the ESP32's bounded queue slot.

        The durable database command retains analysis metadata and the runtime
        snapshot. The device only needs the decision ID, expiry, and exact
        bounded actuator actions to apply its local safety gate.
        """
        payload = payload if isinstance(payload, dict) else {}
        actions = payload.get("actions") if isinstance(payload.get("actions"), dict) else {}
        vibration = actions.get("vibration") if isinstance(actions.get("vibration"), dict) else {}
        sound = actions.get("sound") if isinstance(actions.get("sound"), dict) else {}
        light = actions.get("light") if isinstance(actions.get("light"), dict) else {}
        return {
            "decision_id": str(payload.get("decision_id") or "")[:63],
            "requires_local_safety_gate": True,
            "actions": {
                "vibration": {
                    "enabled": bool(vibration.get("enabled")),
                    "level": int(vibration.get("level") or 0),
                    "duration_ms": int(vibration.get("duration_ms") or 0),
                },
                "sound": {
                    "enabled": bool(sound.get("enabled")),
                    "scene": str(sound.get("scene") or "")[:16],
                    "volume": int(sound.get("volume") or 0),
                    "duration_ms": int(sound.get("duration_ms") or 0),
                },
                "light": {
                    "enabled": bool(light.get("enabled")),
                    "mode": str(light.get("mode") or "")[:24],
                    "color": str(light.get("color") or "amber")[:16],
                    "brightness": int(light.get("brightness") or 0),
                    "duration_ms": int(light.get("duration_ms") or 0),
                },
            },
        }

    def build_device_command_envelope(self, command: dict) -> tuple[dict, bytes]:
        """Serialize the wire command and reject envelopes the ESP32 cannot queue."""
        if not isinstance(command, dict):
            raise ValueError("command is required")
        payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        command_type = str(command.get("command_type") or "")
        if command_type == "cloud_intervention":
            device_payload = self._compact_cloud_intervention_payload(payload)
            envelope = {
                "command_id": str(command.get("command_id") or "")[:63],
                "decision_id": device_payload["decision_id"],
                "type": command_type,
                "payload": device_payload,
                "expires_at": int(command.get("expires_at") or 0),
            }
        else:
            envelope = {
                "command_id": str(command.get("command_id") or "")[:63],
                "decision_id": str(payload.get("decision_id") or "")[:63],
                "type": command_type,
                "payload": payload,
                "expected_config_version": int(command.get("expected_config_version") or 0),
                "created_at": int(command.get("created_at") or 0),
                "expires_at": int(command.get("expires_at") or 0),
            }
        payload_bytes = json.dumps(
            envelope["payload"],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        data = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload_bytes) > ESP32_MQTT_COMMAND_PAYLOAD_MAX_BYTES:
            raise ValueError(
                f"command payload exceeds ESP32 limit: {len(payload_bytes)}>"
                f"{ESP32_MQTT_COMMAND_PAYLOAD_MAX_BYTES}"
            )
        if len(data) > ESP32_MQTT_COMMAND_MAX_BYTES:
            raise ValueError(
                f"command envelope exceeds ESP32 limit: {len(data)}>"
                f"{ESP32_MQTT_COMMAND_MAX_BYTES}"
            )
        return envelope, data

    def publish_command(self, command: dict) -> bool:
        if not command:
            return False
        topic = device_topic(command["device_id"], "commands", "down")
        try:
            envelope, data = self.build_device_command_envelope(command)
        except (TypeError, ValueError) as error:
            self._last_error = f"command_not_publishable:{error}"
            logger.warning("MQTT command not published for %s: %s", topic, error)
            return False
        with self._lock:
            client = self._client
            connected = self._connected
        if not client or not connected:
            return False
        result = client.publish(topic, data.decode("utf-8"), qos=config.MQTT_QOS, retain=False)
        rc = getattr(result, "rc", 0)
        if rc not in (0, None):
            self._last_error = f"publish_failed:{rc}"
            logger.warning("MQTT publish failed for %s rc=%s", topic, rc)
            return False
        with self._lock:
            self._commands_published += 1
            self._last_command_type = str(command.get("command_type") or "")
        logger.info(
            "MQTT command published device=%s type=%s envelope_bytes=%s payload_bytes=%s",
            command["device_id"],
            command["command_type"],
            len(data),
            len(json.dumps(envelope["payload"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
        )
        return True

    def ingest_features(self, device_id: str, payload_bytes: bytes) -> dict:
        if len(payload_bytes) > 2048:
            raise ValueError("feature payload too large")
        window = FeatureWindow.model_validate(self._decode_json(payload_bytes))
        if window.device_id != device_id:
            raise ValueError("feature device_id mismatch")
        with self._lock:
            tracker = self._feature_trackers.setdefault(device_id, FeatureTracker())
            observation = tracker.observe(window, self._now_ms())
            if observation["status"] == "duplicate":
                return observation
            stored = save_feature_snapshot(window.model_dump(), observation)
        # A fresh feature stream cannot refresh stale actuator/sensor telemetry.
        return {"status": "observed", "kind": "features", **stored}

    def _handle_telemetry(self, device_id: str, payload_bytes: bytes) -> dict:
        payload = self._decode_json(payload_bytes)
        if payload.get("device_id") and str(payload["device_id"]) != device_id:
            raise ValueError("telemetry device_id mismatch")
        from app.api.device_runtime import RuntimeSnapshotIn

        payload = RuntimeSnapshotIn.model_validate(payload).model_dump()
        stored = save_runtime_snapshot(device_id, payload)
        fields = {"last_online": self._now()}
        if stored.get("firmware_version"):
            fields["firmware_version"] = stored["firmware_version"]
        if stored.get("night_id"):
            fields["last_night_id"] = stored["night_id"]
        upsert_device(device_id, **fields)
        with self._lock:
            self._telemetry_received += 1
            can_dispatch = self._connected and self._client is not None
        if can_dispatch:
            pending = poll_device_command(device_id)
            if pending:
                self.publish_command(pending)
        return {"status": "ok", "kind": "telemetry", "snapshot": stored}

    def _handle_ack(self, device_id: str, payload_bytes: bytes) -> dict:
        payload = self._decode_json(payload_bytes)
        command_id = str(payload.get("command_id") or "").strip()
        status = str(payload.get("status") or "").strip()
        if not command_id:
            raise ValueError("ack command_id is required")
        if status not in {"applied", "rejected", "failed"}:
            raise ValueError("ack status is invalid")
        persisted = finalize_device_command_ack(
            device_id=device_id,
            command_id=command_id,
            status=status,
            readback=payload.get("readback") if isinstance(payload.get("readback"), dict) else {},
            error_code=str(payload.get("error_code") or "")[:128],
        )
        with self._lock:
            self._acks_received += 1
            self._last_ack_status = status
        logger.info(
            "MQTT command ACK received device=%s status=%s",
            device_id,
            status,
        )
        return {"status": "ok", "kind": "ack", "command": persisted}

    def _handle_audio(self, device_id: str, payload_bytes: bytes) -> dict:
        if not config.MQTT_AUDIO_ENABLED:
            raise ValueError("mqtt audio is disabled")
        if not raw_candidate_audio_allowed(device_id):
            raise ValueError("mqtt audio owner consent is required")
        if len(payload_bytes) > config.MQTT_AUDIO_MAX_PAYLOAD_BYTES:
            raise ValueError("audio payload too large")
        payload = self._decode_json(payload_bytes)
        if payload.get("device_id") and str(payload["device_id"]) != device_id:
            raise ValueError("audio device_id mismatch")
        session_id = str(payload.get("session_id") or "").strip()
        codec = str(payload.get("codec") or "").strip().lower()
        try:
            sequence = int(payload.get("sequence"))
            timestamp_ms = int(payload.get("timestamp_ms"))
            sample_rate = int(payload.get("sample_rate"))
            channels = int(payload.get("channels"))
            frame_samples = int(payload.get("frame_samples"))
        except (TypeError, ValueError) as error:
            raise ValueError("audio integer field is invalid") from error
        data_b64 = payload.get("data_b64")
        if not session_id:
            raise ValueError("audio session_id is required")
        if codec != "pcm_s16le":
            raise ValueError("unsupported audio codec")
        if sample_rate != config.MQTT_AUDIO_SAMPLE_RATE:
            raise ValueError("unexpected audio sample rate")
        if channels != 1:
            raise ValueError("audio must be mono")
        if frame_samples != config.MQTT_AUDIO_FRAME_SAMPLES:
            raise ValueError("audio frame size out of bounds")
        if not isinstance(data_b64, str) or not data_b64:
            raise ValueError("audio data_b64 is required")
        now_ms = self._now_ms()
        if now_ms - timestamp_ms > int(config.MQTT_AUDIO_STALE_SECONDS * 1000):
            raise ValueError("audio frame is stale")
        if timestamp_ms - now_ms > config.MQTT_AUDIO_MAX_FUTURE_MS:
            raise ValueError("audio frame timestamp is in the future")
        try:
            raw_pcm = base64.b64decode(data_b64, validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("audio base64 is invalid") from error
        if len(raw_pcm) > config.MQTT_AUDIO_MAX_PAYLOAD_BYTES:
            raise ValueError("audio raw frame too large")
        expected_bytes = frame_samples * 2
        if len(raw_pcm) != expected_bytes:
            raise ValueError("audio frame length does not match frame_samples")
        with self._lock:
            self._audio_frames_received += 1

        with self._lock:
            state = self._audio_buffers.get(device_id)
            reset_reason = ""
            if state is None:
                state = AudioBufferState(session_id=session_id, detector=RuleBasedSnoreDetector(sr=sample_rate))
                self._audio_buffers[device_id] = state
            elif state.session_id != session_id:
                state = AudioBufferState(session_id=session_id, detector=RuleBasedSnoreDetector(sr=sample_rate))
                self._audio_buffers[device_id] = state
                reset_reason = "session_reset"
            elif state.last_sequence >= 0 and sequence != state.last_sequence + 1:
                state = AudioBufferState(session_id=session_id, detector=RuleBasedSnoreDetector(sr=sample_rate))
                self._audio_buffers[device_id] = state
                reset_reason = "sequence_reset"

            if state.sample_count == 0:
                state.sequence_start = sequence
                state.first_timestamp_ms = timestamp_ms
            state.sequence_end = sequence
            state.last_sequence = sequence
            state.last_timestamp_ms = timestamp_ms
            state.pcm_parts.append(raw_pcm)
            state.sample_count += frame_samples

            max_samples = int(config.MQTT_AUDIO_MAX_CAPTURE_SECONDS * sample_rate)
            while state.sample_count > max_samples and state.pcm_parts:
                removed = state.pcm_parts.pop(0)
                state.sample_count -= len(removed) // 2

        duration_seconds = state.sample_count / float(sample_rate)
        if duration_seconds < config.MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS:
            return {
                "status": "buffering",
                "kind": "audio",
                "device_id": device_id,
                "session_id": session_id,
                "sequence": sequence,
                "duration_seconds": round(duration_seconds, 3),
                "reset_reason": reset_reason or None,
            }

        pcm_bytes = b"".join(state.pcm_parts)
        analysis = self._analyze_window(
            device_id=device_id,
            state=state,
            pcm_bytes=pcm_bytes,
            sample_rate=sample_rate,
        )
        with self._lock:
            self._audio_windows_analyzed += 1
            self._last_analysis_source = analysis.source
            self._last_analysis_confidence = round(analysis.confidence, 4)
        snapshot = get_runtime_snapshot(device_id)
        observation_id = self._persist_audio_observation(device_id, analysis, snapshot)
        decision = self._evaluate_intervention(device_id, analysis, snapshot=snapshot)
        logger.info(
            "MQTT audio window analyzed device=%s source=%s confidence=%.4f observation=%s decision=%s",
            device_id,
            analysis.source,
            analysis.confidence,
            "stored" if observation_id else "skipped",
            decision.get("status") or "unknown",
        )
        state.clear()
        return {
            "status": "analyzed",
            "kind": "audio",
            "device_id": device_id,
            "session_id": session_id,
            "confidence": analysis.confidence,
            "source": analysis.source,
            "observation_recorded": bool(observation_id),
            "decision": decision,
            "reset_reason": reset_reason or None,
        }

    def _persist_audio_observation(
        self,
        device_id: str,
        analysis: AudioWindowResult,
        snapshot: dict,
    ) -> int:
        """Persist a bounded derived observation, never the source audio."""
        if analysis.confidence < config.MQTT_AUDIO_SNORE_THRESHOLD:
            return 0
        now = self._now()
        with self._lock:
            previous = self._last_audio_observation_at.get(device_id, 0)
            if now - previous < config.MQTT_AUDIO_OBSERVATION_COOLDOWN_SECONDS:
                return 0
            self._last_audio_observation_at[device_id] = now
        try:
            observation_id = insert_event(
                {
                    "device_id": device_id,
                    "timestamp": max(1, analysis.timestamp_ms // 1000),
                    "event_type": "snore_candidate",
                    "snore_duration_sec": round(analysis.duration_seconds, 3),
                    "snore_confidence": round(analysis.confidence, 4),
                    "in_bed": snapshot.get("in_bed") if snapshot.get("radar_status") == "ready" else None,
                    "body_motion_level": snapshot.get("body_motion_level") if snapshot.get("radar_status") == "ready" else None,
                    "model_version": f"cloud_audio_{analysis.source}"[:128],
                    "note": "derived_audio_candidate_no_raw_audio",
                }
            )
        except (TypeError, ValueError):
            with self._lock:
                self._last_audio_observation_at.pop(device_id, None)
            raise
        if observation_id:
            with self._lock:
                self._audio_observations_persisted += 1
        return observation_id

    def _analyze_window(
        self,
        *,
        device_id: str,
        state: AudioBufferState,
        pcm_bytes: bytes,
        sample_rate: int,
    ) -> AudioWindowResult:
        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        rule_confidence, features = _fast_rule_audio_analysis(samples, sample_rate)
        confidence = float(rule_confidence)
        source = "rule_based"
        external_metadata = {}
        if config.AUDIO_MODEL_URL:
            try:
                external = self._audio_model_client.analyze(
                    device_id=device_id,
                    session_id=state.session_id,
                    sequence_start=state.sequence_start,
                    sequence_end=state.sequence_end,
                    timestamp_ms=state.last_timestamp_ms,
                    sample_rate=sample_rate,
                    pcm_bytes=pcm_bytes,
                )
                if external:
                    confidence = float(external["confidence"])
                    source = str(external.get("source") or "external_audio_model")
                    external_metadata = {
                        "model": external.get("model") or config.AUDIO_MODEL_NAME or "",
                        **(external.get("metadata") or {}),
                    }
            except (requests.RequestException, ValueError, TypeError) as error:
                source = "rule_based_fallback"
                external_metadata = {"fallback_reason": str(error)}
        return AudioWindowResult(
            device_id=device_id,
            session_id=state.session_id,
            sequence_start=state.sequence_start,
            sequence_end=state.sequence_end,
            timestamp_ms=state.last_timestamp_ms,
            duration_seconds=state.sample_count / float(sample_rate),
            confidence=max(0.0, min(confidence, 1.0)),
            source=source,
            detector_features=features,
            external_metadata=external_metadata,
        )

    def _evaluate_intervention(
        self,
        device_id: str,
        analysis: AudioWindowResult,
        *,
        snapshot: dict | None = None,
    ) -> dict:
        snapshot = snapshot if isinstance(snapshot, dict) else get_runtime_snapshot(device_id)
        now = self._now()
        gate = self._validate_snapshot_gate(device_id, snapshot, now)
        decision_state = self._decisions.setdefault(device_id, CloudDecisionState())
        if analysis.confidence < config.MQTT_AUDIO_SNORE_THRESHOLD:
            decision_state.confirm_hits = 0
            return {
                "status": "no_action",
                "reason": "below_threshold",
                "confidence": analysis.confidence,
            }
        decision_state.confirm_hits += 1
        if not gate["ok"]:
            return {
                "status": "suppressed",
                "reason": gate["reason"],
                "confidence": analysis.confidence,
                "confirm_hits": decision_state.confirm_hits,
            }
        if decision_state.confirm_hits < config.MQTT_AUDIO_CONFIRM_WINDOWS:
            return {
                "status": "confirming",
                "reason": "waiting_more_windows",
                "confidence": analysis.confidence,
                "confirm_hits": decision_state.confirm_hits,
            }
        if now - decision_state.last_command_at < config.MQTT_AUDIO_COOLDOWN_SECONDS:
            return {
                "status": "cooldown",
                "reason": "cooldown_active",
                "confidence": analysis.confidence,
            }
        hour_budget = count_device_commands(
            device_id,
            command_type="cloud_intervention",
            since_ts=now - 3600,
        )
        if hour_budget >= config.MQTT_AUDIO_MAX_COMMANDS_PER_HOUR:
            return {
                "status": "budget_blocked",
                "reason": "hour_budget_exhausted",
                "confidence": analysis.confidence,
            }
        night_budget = count_device_commands(
            device_id,
            command_type="cloud_intervention",
            since_ts=self._night_start_ts(snapshot, now),
        )
        if night_budget >= config.MQTT_AUDIO_MAX_COMMANDS_PER_NIGHT:
            return {
                "status": "budget_blocked",
                "reason": "night_budget_exhausted",
                "confidence": analysis.confidence,
            }

        decision_id = self._decision_id(device_id, analysis)
        command = self._create_intervention_command(device_id, analysis, snapshot, decision_id, now)
        decision_state.confirm_hits = 0
        decision_state.last_command_at = now
        decision_state.last_decision_id = decision_id
        published = False
        if command["status"] in {"expired", "failed", "rejected", "readback-mismatch"}:
            command = requeue_device_command(
                device_id,
                command["command_id"],
                ttl_seconds=config.MQTT_INTERVENTION_COMMAND_TTL_SECONDS,
            )
        if (
            command["status"] in {"pending", "delivered"}
            and decision_state.last_published_command_id != command["command_id"]
        ):
            published = self.publish_command(command)
            if published:
                decision_state.last_published_command_id = command["command_id"]
        return {
            "status": "commanded",
            "reason": "confirmed_snore",
            "confidence": analysis.confidence,
            "decision_id": decision_id,
            "published": published,
            "command_id": command["command_id"],
            "command_status": command["status"],
        }

    def _create_intervention_command(
        self,
        device_id: str,
        analysis: AudioWindowResult,
        snapshot: dict,
        decision_id: str,
        now: int,
    ) -> dict:
        expires_at = now + config.MQTT_INTERVENTION_COMMAND_TTL_SECONDS
        capabilities = snapshot.get("capabilities") if isinstance(snapshot.get("capabilities"), dict) else {}
        sound_driver_available = bool(capabilities.get("sound_driver"))
        light_driver_available = bool(capabilities.get("light_driver"))
        payload = {
            "decision_id": decision_id,
            "reason": "snore_confirmed_by_cloud_audio",
            "confidence": round(analysis.confidence, 4),
            "created_at": now,
            "expires_at": expires_at,
            "requires_local_safety_gate": True,
            "runtime_snapshot": {
                "session_id": snapshot.get("session_id") or "",
                "sequence": int(snapshot.get("sequence") or 0),
                "received_at": int(snapshot.get("received_at") or 0),
                "night_id": snapshot.get("night_id") or "",
            },
            "analysis": {
                "source": analysis.source,
                "window_duration_seconds": round(analysis.duration_seconds, 3),
                "sequence_start": analysis.sequence_start,
                "sequence_end": analysis.sequence_end,
                "timestamp_ms": analysis.timestamp_ms,
                "detector_features": _json_ready(analysis.detector_features),
                "external_metadata": _json_ready(analysis.external_metadata),
            },
            "capabilities": {
                "sound_driver": sound_driver_available,
                "light_driver": light_driver_available,
            },
            "actions": {
                "vibration": {
                    "enabled": True,
                    "level": max(1, min(config.MQTT_INTERVENTION_VIBRATION_LEVEL, 3)),
                    "duration_ms": max(1000, min(config.MQTT_INTERVENTION_VIBRATION_DURATION_MS, 10000)),
                },
                "sound": {
                    "enabled": bool(config.MQTT_INTERVENTION_SOUND_ENABLED and sound_driver_available),
                    "scene": config.MQTT_INTERVENTION_SOUND_SCENE,
                    "volume": max(0, min(config.MQTT_INTERVENTION_SOUND_VOLUME, 100)),
                    "duration_ms": max(1000, min(config.MQTT_INTERVENTION_SOUND_DURATION_MS, 10000)),
                },
                "light": {
                    "enabled": bool(config.MQTT_INTERVENTION_LIGHT_ENABLED and light_driver_available),
                    "mode": config.MQTT_INTERVENTION_LIGHT_MODE,
                    "color": config.MQTT_INTERVENTION_LIGHT_COLOR,
                    "colorTemperatureKelvin": 2200,
                    "rgb": {"r": 255, "g": 132, "b": 34},
                    "brightness": max(5, min(config.MQTT_INTERVENTION_LIGHT_BRIGHTNESS, 40)),
                    "duration_ms": max(1000, min(config.MQTT_INTERVENTION_LIGHT_DURATION_MS, 10000)),
                },
            },
        }
        return create_device_command(
            device_id=device_id,
            command_type="cloud_intervention",
            payload=payload,
            idempotency_key=f"cloud-int:{decision_id}",
            ttl_seconds=config.MQTT_INTERVENTION_COMMAND_TTL_SECONDS,
        )

    def _validate_snapshot_gate(self, device_id: str, snapshot: dict, now: int) -> dict:
        if not snapshot:
            return {"ok": False, "reason": "missing_snapshot"}
        received_at = int(snapshot.get("received_at") or 0)
        if now - received_at > config.MQTT_AUDIO_SNAPSHOT_TTL_SECONDS:
            return {"ok": False, "reason": "stale_snapshot"}
        capabilities = snapshot.get("capabilities") if isinstance(snapshot.get("capabilities"), dict) else {}
        if type(capabilities.get("actuation_guard")) is not int or capabilities.get("actuation_guard") != 1 or capabilities.get("automatic_enabled") is not True:
            return {"ok": False, "reason": "automatic_guard_unverified"}
        if snapshot.get("stop_latched") is not False:
            return {"ok": False, "reason": "stopped_or_unknown"}
        if not bool(snapshot.get("in_bed")):
            return {"ok": False, "reason": "not_in_bed"}
        if not bool(snapshot.get("temperature_ok")):
            return {"ok": False, "reason": "temperature_not_ok"}
        if str(snapshot.get("mic_status") or "") != "ready":
            return {"ok": False, "reason": "mic_not_ready"}
        if str(snapshot.get("radar_status") or "") == "not_installed":
            return {"ok": False, "reason": "radar_not_installed"}
        if str(snapshot.get("radar_status") or "") != "ready":
            return {"ok": False, "reason": "radar_not_ready"}
        if str(snapshot.get("pad_status") or "") != "connected":
            return {"ok": False, "reason": "pad_not_connected"}
        if str(snapshot.get("state") or "") in {"INTERVENTION", "VERIFYING", "SAFETY_LOCKED"}:
            return {"ok": False, "reason": "local_runtime_busy"}
        if int(snapshot.get("active_level") or 0) > 0:
            return {"ok": False, "reason": "local_actuator_active"}
        night_id = snapshot.get("night_id") or get_night_id(device_id, received_at)
        if not night_id:
            return {"ok": False, "reason": "outside_night_window"}
        return {"ok": True, "reason": "ok"}

    def _night_start_ts(self, snapshot: dict, now: int) -> int:
        night_id = str(snapshot.get("night_id") or "")
        if len(night_id) >= 8 and night_id[:8].isdigit():
            local_date = datetime.strptime(night_id[:8], "%Y%m%d")
            local_dt = datetime(
                local_date.year,
                local_date.month,
                local_date.day,
                config.NIGHT_START_HOUR,
                0,
                0,
                tzinfo=ZoneInfo(config.NIGHT_TIMEZONE),
            )
            return int(local_dt.timestamp())
        local_now = datetime.fromtimestamp(now, ZoneInfo(config.NIGHT_TIMEZONE))
        if local_now.hour < config.NIGHT_END_HOUR:
            local_now = local_now - timedelta(days=1)
        local_dt = datetime(
            local_now.year,
            local_now.month,
            local_now.day,
            config.NIGHT_START_HOUR,
            0,
            0,
            tzinfo=ZoneInfo(config.NIGHT_TIMEZONE),
        )
        return int(local_dt.timestamp())

    def _decision_id(self, device_id: str, analysis: AudioWindowResult) -> str:
        digest = hashlib.sha256(
            f"{device_id}:{analysis.session_id}:{analysis.sequence_start}:{analysis.sequence_end}:{analysis.timestamp_ms}".encode(
                "utf-8"
            )
        ).hexdigest()[:24]
        return f"clouddec_{digest}"

    def _decode_json(self, payload_bytes: bytes) -> dict:
        try:
            data = json.loads(payload_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("payload must be valid JSON") from error
        if not isinstance(data, dict):
            raise ValueError("payload root must be an object")
        return data

    def _subscription_topics(self) -> list[str]:
        prefix = topic_prefix()
        topics = [
            f"{prefix}/devices/+/features/up",
            f"{prefix}/devices/+/telemetry/up",
            f"{prefix}/devices/+/acks/up",
        ]
        if config.MQTT_AUDIO_ENABLED:
            topics.insert(0, f"{prefix}/devices/+/audio/up")
        return topics

    def _worker_loop(self) -> None:
        while not self._worker_stop.is_set():
            try:
                item = self._message_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                self._message_queue.task_done()
                break
            topic, payload = item
            started = time.perf_counter()
            try:
                self.ingest_message(topic, payload)
                with self._lock:
                    self._last_message_error = ""
                    self._worker_processed += 1
            except (ValueError, requests.RequestException, TypeError) as error:
                with self._lock:
                    self._worker_failures += 1
                    self._last_message_error = f"{type(error).__name__}: {error}"
                logger.warning("MQTT message rejected on %s: %s", topic, error)
            finally:
                elapsed_ms = (time.perf_counter() - started) * 1000
                with self._lock:
                    self._last_analysis_ms = elapsed_ms
                self._message_queue.task_done()
    def _on_connect(self, client, _userdata, _flags, rc, _properties=None):
        with self._lock:
            self._connected = rc == 0
            self._subscriptions = []
            if rc != 0:
                self._last_error = f"connect_failed:{rc}"
                logger.error(
                    "MQTT connection failed client_id=%s rc=%s",
                    self._runtime_client_id,
                    rc,
                )
                return
            self._connection_count += 1
            self._last_disconnect_code = None
            self._last_error = ""
            for topic in self._subscription_topics():
                client.subscribe(topic, qos=config.MQTT_QOS)
                self._subscriptions.append(topic)
        logger.info(
            "MQTT connected client_id=%s subscriptions=%s",
            self._runtime_client_id,
            len(self._subscriptions),
        )

    def _on_disconnect(self, _client, _userdata, rc, _properties=None):
        with self._lock:
            self._connected = False
            self._last_disconnect_code = rc
            if rc not in (0, None):
                self._last_error = f"disconnect:{rc}"
        if rc not in (0, None):
            logger.warning(
                "MQTT disconnected client_id=%s rc=%s; paho will retry with backoff",
                self._runtime_client_id,
                rc,
            )

    def _on_message(self, _client, _userdata, message):
        topic = str(getattr(message, "topic", "") or "")
        payload = bytes(getattr(message, "payload", b"") or b"")
        if not topic or not payload:
            with self._lock:
                self._worker_dropped += 1
                self._last_message_error = "empty_topic_or_payload"
            return
        try:
            self._message_queue.put_nowait((topic, payload))
            with self._lock:
                self._worker_enqueued += 1
        except queue.Full:
            with self._lock:
                self._worker_dropped += 1
                self._last_message_error = "mqtt_worker_queue_full"
            logger.warning("MQTT worker queue full; dropped message on %s", topic)


_service = MqttRealtimeService()


def get_mqtt_service() -> MqttRealtimeService:
    return _service
