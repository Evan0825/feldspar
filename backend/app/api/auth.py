"""
用户 & 绑定 API
对应时序图第 ① 阶段
"""
from fastapi import APIRouter, HTTPException, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from datetime import datetime, timezone
import hashlib
import httpx
import logging
import re
import secrets
import threading
from urllib.parse import urlparse

from app import config
from app.device_auth import require_device_key
from app.database import (
    gen_id,
    get_conn,
    has_device_credential,
    get_user_by_token,
    get_user_profile,
    set_device_credential,
    update_user_profile,
    upsert_device,
    upsert_user_session,
)

router = APIRouter(prefix="/api/v1", tags=["user & binding"])
logger = logging.getLogger("snoozmate.auth")
_wechat_login_lock = threading.Lock()
_wechat_login_state = {
    "attempt_count": 0,
    "last_attempt_at": 0,
    "last_success_at": 0,
    "last_failure_kind": "",
    "last_wechat_errcode": None,
    "last_identity_source": "",
}
_WECHAT_OPENID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,128}$")


def _record_wechat_login(
    *,
    success: bool,
    failure_kind: str = "",
    errcode: int | None = None,
    identity_source: str = "",
) -> None:
    now = int(datetime.now().timestamp())
    with _wechat_login_lock:
        _wechat_login_state["attempt_count"] += 1
        _wechat_login_state["last_attempt_at"] = now
        _wechat_login_state["last_wechat_errcode"] = errcode
        _wechat_login_state["last_identity_source"] = identity_source
        if success:
            _wechat_login_state["last_success_at"] = now
            _wechat_login_state["last_failure_kind"] = ""
        else:
            _wechat_login_state["last_failure_kind"] = failure_kind


def wechat_login_diagnostics() -> dict:
    """Expose configuration and result classes without leaking AppSecret or codes."""
    parsed = urlparse(config.WECHAT_CODE2SESSION_URL)
    with _wechat_login_lock:
        state = dict(_wechat_login_state)
    return {
        "mode": (
            "production-code2session"
            if config.AUTH_MODE == "production"
            else "code2session"
            if config.AUTH_MODE != "debug" and config.WECHAT_APP_ID and config.WECHAT_APP_SECRET
            else "debug-client-id"
        ),
        "configured": bool(config.WECHAT_APP_ID and config.WECHAT_APP_SECRET),
        "endpoint_host": parsed.hostname or None,
        "cloudbase_header_auth_enabled": config.CLOUDBASE_HEADER_AUTH_ENABLED,
        **state,
    }


def _cloudbase_identity_from_headers(headers) -> tuple[str, str] | None:
    """Read only the gateway-authenticated CloudBase Mini Program identity."""
    if not config.CLOUDBASE_HEADER_AUTH_ENABLED:
        return None

    source = str(headers.get("x-wx-source") or "").strip()
    if not source:
        return None

    from_openid = str(headers.get("x-wx-from-openid") or "").strip()
    from_appid = str(headers.get("x-wx-from-appid") or "").strip()
    using_resource_reuse = bool(from_openid or from_appid)
    openid = from_openid if using_resource_reuse else str(headers.get("x-wx-openid") or "").strip()
    appid = from_appid if using_resource_reuse else str(headers.get("x-wx-appid") or "").strip()
    identity_source = (
        "cloudbase_resource_header"
        if using_resource_reuse
        else "cloudbase_header"
    )

    if not _WECHAT_OPENID_PATTERN.fullmatch(openid):
        _record_wechat_login(
            success=False,
            failure_kind="cloudbase_identity_unavailable",
            identity_source=identity_source,
        )
        logger.warning("CloudBase request did not include a valid WeChat OpenID")
        raise HTTPException(
            status_code=401,
            detail="WECHAT_LOGIN_CLOUDBASE_IDENTITY_UNAVAILABLE",
        )
    if not config.WECHAT_APP_ID:
        _record_wechat_login(
            success=False,
            failure_kind="configuration_error",
            identity_source=identity_source,
        )
        raise HTTPException(
            status_code=503,
            detail="WECHAT_LOGIN_CONFIGURATION_ERROR",
        )
    if not secrets.compare_digest(appid, config.WECHAT_APP_ID):
        _record_wechat_login(
            success=False,
            failure_kind="cloudbase_appid_mismatch",
            identity_source=identity_source,
        )
        logger.warning("Rejected CloudBase login because its AppID did not match the service")
        raise HTTPException(
            status_code=401,
            detail="WECHAT_LOGIN_CLOUDBASE_APPID_MISMATCH",
        )
    return openid, identity_source


def _user_identity_from_openid(openid: str) -> tuple[str, str]:
    digest = hashlib.sha256(openid.encode()).hexdigest()[:20]
    return f"wx_{digest}", f"wx:{digest}"


async def _exchange_wechat_code(login_code: str) -> dict:
    timeout = httpx.Timeout(config.WECHAT_LOGIN_TIMEOUT_SECONDS)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        response = await client.get(
            config.WECHAT_CODE2SESSION_URL,
            params={
                "appid": config.WECHAT_APP_ID,
                "secret": config.WECHAT_APP_SECRET,
                "js_code": login_code,
                "grant_type": "authorization_code",
            },
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("wechat response must be an object")
    return payload


# ═══════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════

class LoginRequest(BaseModel):
    # CloudBase callContainer requests authenticate through trusted headers and
    # therefore do not require a one-time wx.login code.
    login_code: str = Field(default="", max_length=256)
    client_id: str = Field(default="", max_length=128)


class BindRequest(BaseModel):
    binding_token: str
    device_id: str


class BleBindRequest(BindRequest):
    advertised_name: str = Field(min_length=20, max_length=20)
    protocol_version: str = Field(default="1.1", max_length=16)


class DeviceProvisioningCredentialsRequest(BaseModel):
    rotate: bool = False


# ═══════════════════════════════════════
# 登录（微信登录简化版）
# ═══════════════════════════════════════

@router.post("/auth/login")
async def login(req: LoginRequest, request: Request):
    """
    微信登录 → 返回 userId + 业务会话
    比赛/开发阶段：用假 code 测试，test_code_xxx → test_user_xxx
    """
    now = int(datetime.now().timestamp())
    user_id, openid = await _resolve_login_identity(req, request.headers)
    session_token = gen_id("sess")
    expires_at = now + config.SESSION_TTL_SECONDS
    user = upsert_user_session(user_id, openid, session_token, expires_at)
    profile = {
        "id": user_id,
        "nickname": user.get("nickname") or "月石用户",
        "sleepMode": user.get("sleep_mode") or "shared",
        "excludeSoundReminder": bool(user.get("exclude_sound_reminder", 0)),
        "excludeLightReminder": bool(user.get("exclude_light_reminder", 0)),
        "privacyAccepted": bool(user.get("privacy_accepted")),
        "aiDataAuthorized": bool(user.get("ai_data_authorized")),
        "aiConsentVersion": user.get("ai_consent_version") or "",
        "rawAudioCandidateConsent": bool(user.get("raw_audio_candidate_consent")),
        "mqttAudioAuthorized": bool(user.get("raw_audio_candidate_consent")),
    }
    return {
        "user_id": user_id,
        "session_token": session_token,
        "nickname": user.get("nickname") or "月石用户",
        "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
        "expires_in": config.SESSION_TTL_SECONDS,
        "profile": profile,
    }


# ═══════════════════════════════════════
# 设备绑定令牌
# ═══════════════════════════════════════

@router.post("/binding/token")
def get_binding_token(
    device_id: str = "",
    authorization: str = Header(default=""),
):
    """Issue a short-lived token for an owner or shared BLE member."""
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="未登录")
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id 不能为空")

    # 确保设备存在
    upsert_device(device_id)

    binding_token = gen_id("bind")
    now = int(datetime.now().timestamp())
    conn = get_conn()
    try:
        c = conn.cursor()
        owner = c.execute(
            """SELECT user_id FROM device_bindings
               WHERE device_id=? AND status='active' AND role='owner'
               ORDER BY id LIMIT 1""",
            (device_id,),
        ).fetchone()
        binding_role = (
            "member"
            if owner and owner["user_id"] != user_id
            else "owner"
        )
        existing = c.execute(
            "SELECT status FROM device_bindings WHERE user_id=? AND device_id=?",
            (user_id, device_id),
        ).fetchone()
        if existing:
            # An active shared link remains active while the user reconnects.
            # Revoked and interrupted links require the subsequent BLE proof.
            status = "active" if existing["status"] == "active" else "pending"
            c.execute(
                """UPDATE device_bindings
                   SET binding_token=?,created_at=?,role=?,status=?
                   WHERE user_id=? AND device_id=?""",
                (binding_token, now, binding_role, status, user_id, device_id),
            )
        else:
            c.execute(
                """INSERT INTO device_bindings(
                     user_id,device_id,role,binding_token,status,created_at
                   ) VALUES(?,?,?,?,?,?)""",
                (user_id, device_id, binding_role, binding_token, "pending", now),
            )
        conn.commit()
    finally:
        conn.close()

    return {
        "binding_token": binding_token,
        "device_id": device_id,
        "expires_in": 3600,
        "binding_role": binding_role,
        "shared_access": binding_role == "member",
    }


@router.post("/binding/confirm")
def confirm_binding(req: BindRequest, x_device_key: str = Header(default="")):
    """
    设备端确认绑定（设备拿到 binding_token 后调用）
    把状态从 pending 改成 active
    """
    require_device_key(req.device_id, x_device_key)
    return _activate_pending_binding(req.binding_token, req.device_id)


@router.post("/binding/confirm-ble")
def confirm_ble_binding(
    req: BleBindRequest,
    authorization: str = Header(default=""),
):
    """Activate an owner or shared member after BLE GATT verification.

    A physical connection remains required, but a second user is added as a
    member instead of replacing or blocking the existing owner.
    """
    if not config.ALLOW_BLE_LOCAL_BINDING:
        raise HTTPException(status_code=409, detail="BLE_LOCAL_BINDING_DISABLED")
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    advertised_name = req.advertised_name.strip().upper()
    match = re.fullmatch(r"HAOMIAN-SLEEP_([0-9A-F]{6})", advertised_name)
    if not match or req.protocol_version not in {"1.0", "1.1"}:
        raise HTTPException(status_code=400, detail="BLE_IDENTITY_INVALID")
    expected_device_id = f"haomian_sleep_{match.group(1).lower()}"
    if req.device_id != expected_device_id:
        raise HTTPException(status_code=400, detail="BLE_IDENTITY_MISMATCH")
    result = _activate_pending_binding(
        req.binding_token,
        req.device_id,
        expected_user_id=user_id,
        mark_online=False,
        allow_shared_access=True,
    )
    return {
        **result,
        "binding_method": "ble-local-v1" if req.protocol_version == "1.0" else "ble-local-v1.1",
        "advertised_name": advertised_name,
    }


@router.delete("/device/{device_id}/binding")
def unbind_device(
    device_id: str,
    authorization: str = Header(default=""),
):
    """Remove only the caller's shared link without deleting device history."""
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id 不能为空")

    conn = get_conn()
    try:
        c = conn.cursor()
        c.execute("BEGIN IMMEDIATE")
        binding = c.execute(
            """SELECT id,role FROM device_bindings
               WHERE user_id=? AND device_id=? AND status='active'
               ORDER BY id LIMIT 1""",
            (user_id, device_id),
        ).fetchone()
        if not binding:
            raise HTTPException(status_code=404, detail="DEVICE_NOT_FOUND")
        c.execute(
            """UPDATE device_bindings SET status='revoked',binding_token=''
               WHERE id=?""",
            (binding["id"],),
        )
        promoted_member = False
        if binding["role"] == "owner":
            replacement = c.execute(
                """SELECT id FROM device_bindings
                   WHERE device_id=? AND status='active' AND role='member'
                   ORDER BY id LIMIT 1""",
                (device_id,),
            ).fetchone()
            if replacement:
                c.execute(
                    "UPDATE device_bindings SET role='owner' WHERE id=?",
                    (replacement["id"],),
                )
                promoted_member = True
        conn.commit()
        return {
            "status": "unbound",
            "device_id": device_id,
            "promoted_shared_member": promoted_member,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.post("/device/{device_id}/provisioning-credentials")
def create_device_provisioning_credentials(
    device_id: str,
    req: DeviceProvisioningCredentialsRequest = None,
    authorization: str = Header(default=""),
):
    """Issue a device key once, or rotate it after a device factory reset.

    The caller must be the active owner established by the BLE proximity flow.
    Raw keys are never stored by the backend and this response is explicitly
    non-cacheable.
    """
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    conn = get_conn()
    try:
        binding = conn.execute(
            """SELECT role FROM device_bindings
               WHERE user_id=? AND device_id=? AND status='active'
               ORDER BY id LIMIT 1""",
            (user_id, device_id),
        ).fetchone()
    finally:
        conn.close()
    if not binding or binding["role"] != "owner":
        raise HTTPException(status_code=404, detail="DEVICE_NOT_FOUND")

    rotate = bool(req and req.rotate)
    existing = has_device_credential(device_id)
    if existing and not rotate:
        payload = {
            "device_id": device_id,
            "device_key": "",
            "credential_action": "retain",
        }
    else:
        raw_key = secrets.token_urlsafe(32)
        set_device_credential(device_id, raw_key)
        payload = {
            "device_id": device_id,
            "device_key": raw_key,
            "credential_action": "rotated" if existing else "created",
        }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


def _activate_pending_binding(
    binding_token: str,
    device_id: str,
    *,
    expected_user_id: str = "",
    mark_online: bool = True,
    allow_shared_access: bool = False,
) -> dict:
    conn = get_conn()
    c = conn.cursor()
    now = int(datetime.now().timestamp())
    c.execute("BEGIN IMMEDIATE")
    try:
        # Serialize owner assignment for this device across concurrent confirmations.
        c.execute("UPDATE devices SET device_id=device_id WHERE device_id=?", (device_id,))
        query = """SELECT * FROM device_bindings WHERE binding_token=? AND device_id=?
                   AND status IN ('pending','active') AND created_at>?"""
        params: tuple = (binding_token, device_id, now - 3600)
        if expected_user_id:
            query += " AND user_id=?"
            params += (expected_user_id,)
        row = c.execute(query, params).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="绑定令牌无效")

        binding_role = str(row["role"] or "member")
        owner = c.execute(
            """SELECT user_id FROM device_bindings
               WHERE device_id=? AND status='active' AND role='owner' AND user_id<>?
               ORDER BY id LIMIT 1""",
            (device_id, row["user_id"]),
        ).fetchone()
        if owner and binding_role == "owner" and not allow_shared_access:
            raise HTTPException(status_code=409, detail="ALREADY_BOUND")
        if owner and binding_role == "owner":
            # Two first-time BLE joins can race. The second still becomes a
            # shared user rather than failing after it proved local proximity.
            binding_role = "member"
        if binding_role not in {"owner", "member", "viewer"}:
            binding_role = "member"
        c.execute(
            "UPDATE device_bindings SET status='active',role=? WHERE id=?",
            (binding_role, row["id"]),
        )
        if mark_online:
            c.execute("UPDATE devices SET last_online=? WHERE device_id=?", (now, device_id))
        device = c.execute(
            "SELECT config_version FROM devices WHERE device_id=?",
            (device_id,),
        ).fetchone()
        conn.commit()
        return {
            "status": "active",
            "device_id": device_id,
            "config_version": device["config_version"] if device else 1,
            "binding_role": binding_role,
            "shared_access": binding_role == "member",
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.get("/user/devices")
def list_user_devices(authorization: str = Header(default="")):
    """Return only devices actively bound to the authenticated user."""
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")

    conn = get_conn()
    c = conn.cursor()
    c.execute('''SELECT d.*, b.role FROM device_bindings b
                 JOIN devices d ON b.device_id = d.device_id
                 WHERE b.user_id=? AND b.status='active' ''', (user_id,))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return {"user_id": user_id, "devices": rows, "count": len(rows)}



@router.get("/user/me/profile")
def get_me_profile(authorization: str = Header(default="")):
    """获取持久化 profile（兼容前端字段）"""
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    return get_user_profile(user_id)


@router.put("/user/me/profile")
def save_me_profile(authorization: str = Header(default=""), body: dict = None):
    """Patch and persist profile without resetting omitted consent fields."""
    user_id = _get_user_from_token(authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="AUTH_EXPIRED")
    incoming = body or {}
    aliases = {
        "nickname": "nickname",
        "sleepMode": "sleepMode",
        "sleep_mode": "sleepMode",
        "excludeSoundReminder": "excludeSoundReminder",
        "exclude_sound_reminder": "excludeSoundReminder",
        "excludeLightReminder": "excludeLightReminder",
        "exclude_light_reminder": "excludeLightReminder",
        "privacyAccepted": "privacyAccepted",
        "privacy_accepted": "privacyAccepted",
        "aiDataAuthorized": "aiDataAuthorized",
        "ai_data_authorized": "aiDataAuthorized",
        "aiConsentVersion": "aiConsentVersion",
        "ai_consent_version": "aiConsentVersion",
        "rawAudioCandidateConsent": "rawAudioCandidateConsent",
        "raw_audio_candidate_consent": "rawAudioCandidateConsent",
        "mqttAudioAuthorized": "rawAudioCandidateConsent",
        "mqtt_audio_authorized": "rawAudioCandidateConsent",
    }
    patch = {target: incoming[source] for source, target in aliases.items() if source in incoming}
    if "nickname" in patch:
        patch["nickname"] = str(patch["nickname"]).strip()
        if not patch["nickname"] or len(patch["nickname"]) > 40:
            raise HTTPException(status_code=400, detail="nickname 长度必须为 1-40")
    if "sleepMode" in patch and patch["sleepMode"] not in {"solo", "shared"}:
        raise HTTPException(status_code=400, detail="sleepMode 必须为 solo 或 shared")
    for key in ("excludeSoundReminder", "excludeLightReminder"):
        if key in patch and not isinstance(patch[key], bool):
            raise HTTPException(status_code=400, detail=f"{key} 必须为布尔值")
    return update_user_profile(user_id, patch)


# ═══════════════════════════════════════
# 工具
# ═══════════════════════════════════════

def _get_user_from_token(auth_header: str) -> str:
    """从 Authorization header 提取用户ID
    简化版：Bearer <session_token>
    """
    if not auth_header or not auth_header.startswith("Bearer "):
        return ""
    token = auth_header.replace("Bearer ", "").strip()
    user = get_user_by_token(token)
    return user.get("user_id", "")


async def _resolve_login_identity(req: LoginRequest, headers=None) -> tuple[str, str]:
    cloudbase_identity = _cloudbase_identity_from_headers(headers or {})
    if cloudbase_identity:
        openid, identity_source = cloudbase_identity
        _record_wechat_login(success=True, identity_source=identity_source)
        return _user_identity_from_openid(openid)

    login_code = req.login_code.strip()
    if not login_code:
        raise HTTPException(status_code=400, detail="login_code 不能为空")
    if config.AUTH_MODE != "production" and login_code.startswith("test_code_"):
        suffix = login_code.removeprefix("test_code_") or "default"
        return f"user_{suffix}", f"test:{suffix}"

    if config.AUTH_MODE == "production" and not (config.WECHAT_APP_ID and config.WECHAT_APP_SECRET):
        raise HTTPException(status_code=503, detail="微信登录尚未配置")

    if config.AUTH_MODE != "debug" and config.WECHAT_APP_ID and config.WECHAT_APP_SECRET:
        try:
            payload = await _exchange_wechat_code(login_code)
        except httpx.TimeoutException as exc:
            _record_wechat_login(
                success=False,
                failure_kind="upstream_timeout",
                identity_source="code2session",
            )
            logger.warning("WeChat code2session timed out")
            raise HTTPException(
                status_code=503,
                detail="WECHAT_LOGIN_UPSTREAM_TIMEOUT",
            ) from exc
        except httpx.HTTPError as exc:
            _record_wechat_login(
                success=False,
                failure_kind="upstream_network_error",
                identity_source="code2session",
            )
            logger.warning("WeChat code2session network failure: %s", type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail="WECHAT_LOGIN_UPSTREAM_UNAVAILABLE",
            ) from exc
        except ValueError as exc:
            _record_wechat_login(
                success=False,
                failure_kind="invalid_upstream_response",
                identity_source="code2session",
            )
            logger.warning("WeChat code2session returned an invalid response")
            raise HTTPException(
                status_code=503,
                detail="WECHAT_LOGIN_UPSTREAM_INVALID_RESPONSE",
            ) from exc
        errcode = payload.get("errcode")
        if errcode not in (None, 0, "0"):
            try:
                code = int(errcode)
            except (TypeError, ValueError):
                code = None
            _record_wechat_login(
                success=False,
                failure_kind="wechat_error",
                errcode=code,
                identity_source="code2session",
            )
            logger.warning("WeChat code2session rejected login: errcode=%s", code)
            if code in {40029, 40163, 41008}:
                raise HTTPException(status_code=401, detail="WECHAT_LOGIN_CODE_INVALID")
            raise HTTPException(status_code=503, detail="WECHAT_LOGIN_CONFIGURATION_ERROR")
        openid = str(payload.get("openid") or "").strip()
        if not openid:
            _record_wechat_login(
                success=False,
                failure_kind="missing_openid",
                identity_source="code2session",
            )
            raise HTTPException(status_code=401, detail="微信登录凭据无效")
        _record_wechat_login(success=True, identity_source="code2session")
        return _user_identity_from_openid(openid)

    if config.AUTH_MODE == "production":
        raise HTTPException(status_code=401, detail="微信登录凭据无效")

    # Debug fallback: client_id is generated once by the mini program and remains
    # stable even though wx.login returns a different one-time code on each call.
    identity = req.client_id.strip() or req.login_code.strip()
    namespace = "client" if req.client_id.strip() else "code"
    digest = hashlib.sha256(identity.encode()).hexdigest()[:20]
    return f"{namespace}_{digest}", f"{namespace}:{digest}"
    set_device_credential,
