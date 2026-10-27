"""MQTT topic helpers shared by the service and EMQX HTTP auth/ACL routes."""
from __future__ import annotations

from app import config

_UP_KINDS = {"audio", "features", "telemetry", "acks"}
_DOWN_KINDS = {"commands"}


def topic_prefix() -> str:
    return str(config.MQTT_TOPIC_PREFIX).strip().strip("/")


def device_topic(device_id: str, channel: str, direction: str) -> str:
    prefix = topic_prefix()
    return f"{prefix}/devices/{device_id}/{channel}/{direction}"


def parse_device_topic(topic: str) -> dict:
    parts = str(topic or "").strip("/").split("/")
    prefix = topic_prefix().split("/")
    if len(parts) != len(prefix) + 4:
        return {}
    if parts[: len(prefix)] != prefix:
        return {}
    if parts[len(prefix)] != "devices":
        return {}
    device_id = parts[len(prefix) + 1]
    channel = parts[len(prefix) + 2]
    direction = parts[len(prefix) + 3]
    if not device_id or not channel or not direction:
        return {}
    return {
        "device_id": device_id,
        "channel": channel,
        "direction": direction,
    }


def allowed_device_publish_topics(device_id: str) -> tuple[str, ...]:
    return tuple(device_topic(device_id, channel, "up") for channel in sorted(_UP_KINDS))


def allowed_device_subscribe_topics(device_id: str) -> tuple[str, ...]:
    return tuple(device_topic(device_id, channel, "down") for channel in sorted(_DOWN_KINDS))


def is_allowed_device_publish_topic(device_id: str, topic: str) -> bool:
    return topic in allowed_device_publish_topics(device_id)


def is_allowed_device_subscribe_topic(device_id: str, topic: str) -> bool:
    return topic in allowed_device_subscribe_topics(device_id)
