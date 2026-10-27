"""Device credential helpers. Raw device keys are never stored."""
from __future__ import annotations

from fastapi import HTTPException

from app import config
from app.database import verify_device_credential


def require_device_key(device_id: str, raw_key: str) -> None:
    if not config.REQUIRE_DEVICE_AUTH:
        return
    if not raw_key or not verify_device_credential(device_id, raw_key):
        raise HTTPException(status_code=401, detail="DEVICE_AUTH_REQUIRED")
