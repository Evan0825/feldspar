"""Reusable user-session and device-access checks."""
from __future__ import annotations

from fastapi import HTTPException

from app import config
from app.database import get_user_by_token, user_has_device_access


def current_user_id(authorization: str) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        return ""
    token = authorization.removeprefix("Bearer ").strip()
    user = get_user_by_token(token)
    return str(user.get("user_id") or "")


def require_user_device_access(
    authorization: str,
    device_id: str,
    *,
    write: bool = False,
) -> str:
    if not config.REQUIRE_USER_DEVICE_AUTH:
        return "compatibility-user"
    user_id = current_user_id(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    if config.DEVICE_ACCESS_MODE == "shared":
        return user_id
    if not user_has_device_access(user_id, device_id, write=write):
        # Do not reveal whether the requested device exists.
        raise HTTPException(status_code=404, detail="DEVICE_NOT_FOUND")
    return user_id
