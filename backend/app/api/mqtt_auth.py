"""EMQX-compatible HTTP auth/ACL endpoints for device-scoped MQTT access."""
from __future__ import annotations

import hmac
import json
from urllib.parse import parse_qs

from fastapi import APIRouter, Header, HTTPException, Request

from app import config
from app.database import verify_device_credential
from app.mqtt_topics import (
    allowed_device_publish_topics,
    allowed_device_subscribe_topics,
    topic_prefix,
)

router = APIRouter(prefix="/api/v1/mqtt", tags=["mqtt auth"])


async def _read_payload(request: Request) -> dict:
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    body = await request.body()
    if not body:
        return dict(request.query_params)
    if content_type == "application/json":
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=400, detail="INVALID_JSON") from error
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="INVALID_PAYLOAD")
        return payload
    if content_type == "application/x-www-form-urlencoded":
        return {
            key: values[-1]
            for key, values in parse_qs(body.decode("utf-8"), keep_blank_values=True).items()
            if values
        }
    raise HTTPException(status_code=415, detail="UNSUPPORTED_CONTENT_TYPE")


def _guard_router(shared_secret: str) -> None:
    if not config.MQTT_HTTP_AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="MQTT_HTTP_AUTH_DISABLED")
    expected = config.MQTT_HTTP_AUTH_SHARED_SECRET
    if not expected:
        raise HTTPException(status_code=503, detail="MQTT_HTTP_AUTH_MISCONFIGURED")
    if not shared_secret or not hmac.compare_digest(shared_secret, expected):
        raise HTTPException(status_code=403, detail="MQTT_HTTP_AUTH_FORBIDDEN")


def _normalize_access(payload: dict) -> str:
    raw = payload.get("access")
    if raw in (1, "1", "subscribe"):
        return "subscribe"
    if raw in (2, "2", "publish"):
        return "publish"
    if raw in (3, "3", "pubsub", "all"):
        return "all"
    action = str(payload.get("action") or "").strip().lower()
    if action in {"publish", "subscribe", "all", "pubsub"}:
        return "all" if action in {"all", "pubsub"} else action
    return ""


def _service_account_allowed(username: str, password: str) -> bool:
    return bool(
        config.MQTT_SERVICE_USERNAME
        and config.MQTT_SERVICE_PASSWORD
        and hmac.compare_digest(username, config.MQTT_SERVICE_USERNAME)
        and hmac.compare_digest(password, config.MQTT_SERVICE_PASSWORD)
    )


@router.post("/emqx/auth")
async def emqx_auth(
    request: Request,
    x_mqtt_auth_secret: str = Header(default="", alias="X-MQTT-Auth-Secret"),
):
    _guard_router(x_mqtt_auth_secret)
    payload = await _read_payload(request)
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if _service_account_allowed(username, password):
        return {"result": "allow", "is_superuser": True}
    if username and password and verify_device_credential(username, password):
        return {"result": "allow", "is_superuser": False}
    return {"result": "deny", "is_superuser": False}


@router.post("/emqx/acl")
async def emqx_acl(
    request: Request,
    x_mqtt_auth_secret: str = Header(default="", alias="X-MQTT-Auth-Secret"),
):
    _guard_router(x_mqtt_auth_secret)
    payload = await _read_payload(request)
    username = str(payload.get("username") or "").strip()
    topic = str(payload.get("topic") or "").strip()
    access = _normalize_access(payload)
    if not username or not topic or not access:
        return {"result": "deny"}
    if username == config.MQTT_SERVICE_USERNAME and config.MQTT_SERVICE_USERNAME:
        return {"result": "allow" if topic.startswith(f"{topic_prefix()}/") else "deny"}
    if access in {"publish", "all"} and topic in allowed_device_publish_topics(username):
        return {"result": "allow"}
    if access in {"subscribe", "all"} and topic in allowed_device_subscribe_topics(username):
        return {"result": "allow"}
    return {"result": "deny"}
