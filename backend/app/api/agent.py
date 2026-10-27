import time
import json
import hashlib
import asyncio
import httpx

# LLM 解读缓存：同 night_id + summary 指纹 30 分钟内复用
_morning_report_cache: dict = {}
"""
Agent 决策 API + 晨报 + 七晚学习 + 候选配置 + 反馈
对应时序图：②睡前设置 / ④晨间同步与AI解读 / ⑤用户确认
"""
from fastapi import APIRouter, HTTPException, Header
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, date
import json

from app.models.schemas import AgentTick, AgentDecision, DeviceConfig
from app import config as app_config
from app.access import require_user_device_access
from app.device_auth import require_device_key
from app.agent.engine import SnoozMateAgent
from app.agent.safety import validate_agent_config
from app.agent.candidates import (
    create_candidate, list_candidates, get_candidate,
    approve_candidate, reject_candidate, generate_ai_candidate,
    get_application_log,
)
from app.agent.ai_interpretation import (
    build_report_context,
    generate_ai_interpretation,
    generate_chat_fallback,
    has_unsafe_medical_instruction,
    claims_no_record,
    ground_ai_interpretation,
    generate_rule_interpretation,
    normalize_llm_chat_reply,
    request_llm_chat,
)
from app.database import (
    get_device_config, get_recent_events, get_night_id, get_latest_night_id,
    compute_daily_summary, get_daily_summary, get_weekly_stats,
    update_device_config, get_device, upsert_device,
    get_conn, get_latest_event_metadata, get_saved_ai_interpretation, save_ai_interpretation,
    create_device_command, get_active_device_command, get_device_command,
    requeue_device_command,
)
from app.config import DEFAULT_AGENT_CONFIG, DEVICE_ONLINE_TTL_SECONDS

router = APIRouter(prefix="/api/v1", tags=["agent"])

_agents = {}


def _require_cloud_agent_debug():
    if not app_config.ENABLE_CLOUD_AGENT_DEBUG:
        raise HTTPException(status_code=404, detail="CLOUD_AGENT_DEBUG_DISABLED")


def _event_data_source(events: list) -> str:
    if not events:
        return "none"
    versions = {str(event.get("model_version") or "").lower() for event in events}
    simulated = ("simulator", "demo", "mock")
    simulated_count = sum(any(tag in version for tag in simulated) for version in versions)
    if simulated_count == len(versions):
        return "simulated"
    if simulated_count:
        return "mixed"
    return "device"


def get_agent(device_id: str) -> SnoozMateAgent:
    if device_id not in _agents:
        config = get_device_config(device_id)
        _agents[device_id] = SnoozMateAgent(config, device_id)
    return _agents[device_id]


# ═══════════════════════════════════════
# 实时 Agent 决策（调试/演示用）
# ═══════════════════════════════════════

@router.post("/agent/tick", response_model=AgentDecision)
def agent_tick(tick: AgentTick, x_device_key: str = Header(default="")):
    _require_cloud_agent_debug()
    require_device_key(tick.device_id, x_device_key)
    agent = get_agent(tick.device_id)
    result = agent.process_tick(
        audio_confidence=tick.audio_confidence,
        in_bed=tick.in_bed,
        body_motion_level=tick.body_motion_level,
        temp_ok=tick.temp_ok,
        hardware_ready=tick.hardware_ready,
        is_partner=tick.is_partner,
        elapsed_seconds=tick.elapsed_seconds,
    )
    status = agent.get_status()
    return AgentDecision(
        action=result.get("action", "NONE"),
        reason=result.get("reason", ""),
        level=result.get("level", 0),
        state=status["state"],
        rounds_done=status["rounds_done"],
        rounds_remaining=status["rounds_remaining"],
        snore_streak=status["snore_streak"],
        recent_log=status["decisions"],
        events=agent.drain_events(),
    )


@router.post("/agent/{device_id}/bedtime")
def notify_bedtime(device_id: str, x_device_key: str = Header(default="")):
    _require_cloud_agent_debug()
    require_device_key(device_id, x_device_key)
    agent = get_agent(device_id)
    agent.notify_bedtime()
    return {"status": "ok"}


@router.post("/agent/{device_id}/reset")
def reset_agent(device_id: str, x_device_key: str = Header(default="")):
    _require_cloud_agent_debug()
    require_device_key(device_id, x_device_key)
    agent = get_agent(device_id)
    agent.reset_night()
    return {"status": "ok"}


@router.get("/agent/{device_id}/status")
def agent_status(device_id: str):
    _require_cloud_agent_debug()
    agent = get_agent(device_id)
    return agent.get_status()


# ═══════════════════════════════════════
# 设备配置（睡前设置）
# ═══════════════════════════════════════

@router.get("/device/{device_id}/config")
def get_config(device_id: str, authorization: str = Header(default="")):
    """获取设备配置 + 当前版本号"""
    require_user_device_access(authorization, device_id)
    device = get_device(device_id)
    if not device:
        upsert_device(device_id)
        device = get_device(device_id)
    config = get_device_config(device_id)
    return {
        "device_id": device_id,
        "config": config,
        "config_version": device["config_version"],
        "name": device["name"],
        "mode": device["mode"],
    }


class ConfigUpdate(BaseModel):
    config: dict
    mode: Optional[str] = None


@router.put("/device/{device_id}/config")
def update_config(
    device_id: str,
    update: ConfigUpdate,
    x_device_key: str = Header(default=""),
):
    """
    更新设备配置 → 返回新版本号 + 配置回读
    对应时序图 ② 阶段：settings_update → ACK + configVersion
    """
    _require_cloud_agent_debug()
    require_device_key(device_id, x_device_key)
    device = get_device(device_id)
    if not device:
        upsert_device(device_id)
        device = get_device(device_id)

    try:
        validate_agent_config(update.config, allow_partial=True)
        validate_agent_config({**get_device_config(device_id), **update.config})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"配置超出安全边界: {error}") from error

    if update.mode:
        if update.mode not in ("solo", "partner"):
            raise HTTPException(status_code=400, detail="mode 必须为 solo 或 partner")
    new_version = update_device_config(device_id, update.config)
    if update.mode:
        upsert_device(device_id, mode=update.mode)

    # 刷新内存中的 agent
    if device_id in _agents:
        _agents[device_id].config = get_device_config(device_id)

    return {
        "status": "ok",
        "config_version": new_version,
        "config": get_device_config(device_id),
    }


@router.get("/device/{device_id}/status")
def device_status(device_id: str, authorization: str = Header(default="")):
    """Device connectivity is based on actual binding, heartbeat or event traffic."""
    require_user_device_access(authorization, device_id)
    device = get_device(device_id)
    if not device:
        upsert_device(device_id)
        device = get_device(device_id)
    now = int(datetime.now().timestamp())
    last_online = int(device.get("last_online") or 0)
    online = last_online > 0 and now - last_online <= DEVICE_ONLINE_TTL_SECONDS
    latest_event = get_latest_event_metadata(device_id)
    data_source = _event_data_source([latest_event] if latest_event else [])
    return {
        "device_id": device_id,
        "device_status": "online" if online else "offline",
        "config_version": device["config_version"],
        "firmware_version": device["firmware_version"],
        "name": device["name"],
        "mode": device["mode"],
        "last_online": last_online,
        "online_ttl_seconds": DEVICE_ONLINE_TTL_SECONDS,
        "has_data": bool(latest_event),
        "last_event_at": latest_event.get("timestamp", 0),
        "last_night_id": latest_event.get("night_id", ""),
        "data_source": data_source,
    }


class DeviceHeartbeat(BaseModel):
    firmware_version: Optional[str] = Field(default=None, max_length=64)
    last_night_id: Optional[str] = Field(default=None, max_length=256)


@router.post("/device/{device_id}/heartbeat")
def device_heartbeat(
    device_id: str,
    heartbeat: DeviceHeartbeat = None,
    x_device_key: str = Header(default=""),
):
    """Hardware heartbeat; devices should call this periodically when no events occur."""
    require_device_key(device_id, x_device_key)
    values = {"last_online": int(datetime.now().timestamp())}
    if heartbeat and heartbeat.firmware_version:
        values["firmware_version"] = heartbeat.firmware_version
    if heartbeat and heartbeat.last_night_id:
        values["last_night_id"] = heartbeat.last_night_id
    upsert_device(device_id, **values)
    device = get_device(device_id)
    latest_event = get_latest_event_metadata(device_id)
    now = int(datetime.now().timestamp())
    return {
        "device_id": device_id,
        "device_status": "online",
        "config_version": device["config_version"],
        "firmware_version": device["firmware_version"],
        "name": device["name"],
        "mode": device["mode"],
        "last_online": now,
        "online_ttl_seconds": DEVICE_ONLINE_TTL_SECONDS,
        "has_data": bool(latest_event),
        "last_event_at": latest_event.get("timestamp", 0),
        "last_night_id": latest_event.get("night_id", ""),
        "data_source": _event_data_source([latest_event] if latest_event else []),
    }


# ═══════════════════════════════════════
# 晨间报告
# ═══════════════════════════════════════

@router.get("/morning_report/{device_id}")
async def morning_report(
    device_id: str,
    night_id: str = "",
    generate_ai: bool = True,
    cached: bool = False,
    authorization: str = Header(default=""),
):
    """
    完整晨报：数据摘要 + AI解读 + 七晚趋势
    对应时序图 ④ 阶段
    """
    require_user_device_access(authorization, device_id)
    if not night_id:
        night_id = get_latest_night_id(device_id) or get_night_id(device_id)

    # Events are authoritative. Recompute cheaply before every report so late batch
    # events cannot leave a stale summary/cache fingerprint behind.
    summary = await run_in_threadpool(compute_daily_summary, device_id, night_id)
    from app.database import get_night_events
    events, weekly = await asyncio.gather(
        run_in_threadpool(get_night_events, device_id, night_id),
        run_in_threadpool(get_weekly_stats, device_id, 7),
    )

    # ===== LLM 缓存优化：进程内缓存（同进程 30 分钟有效）=====
    ai_interp = {}
    if generate_ai:
        # 缓存 key = (device_id, night_id, summary 指纹)
        import hashlib
        summary_fingerprint = hashlib.md5(
            json.dumps(summary, sort_keys=True, ensure_ascii=False, default=str).encode()
        ).hexdigest()[:8]
        cache_key = f"{device_id}:{night_id}:{summary_fingerprint}"
        cache_hit = False
        if cached:
            cached_data = _morning_report_cache.get(cache_key)
            now = time.time()
            if cached_data and (now - cached_data["ts"]) < 1800:
                ai_interp = cached_data["data"]
                ai_interp["source"] = ai_interp.get("source", "cache")
                cache_hit = True
        if not cache_hit:
            ctx = build_report_context(summary, weekly)
            stored = await run_in_threadpool(get_saved_ai_interpretation, device_id, night_id)
            if cached:
                ai_interp = ground_ai_interpretation(stored, ctx) if stored else generate_rule_interpretation(ctx)
                if not stored:
                    ai_interp["source"] = "rule_based_cached_miss"
            else:
                ai_interp = await generate_ai_interpretation(ctx)
                if ai_interp.get("source") == "llm":
                    await run_in_threadpool(save_ai_interpretation, device_id, night_id, ai_interp)
            _morning_report_cache[cache_key] = {"ts": time.time(), "data": ai_interp}

        # 如果 AI 建议调整参数 → 自动生成候选（同一夜只生成一次）
        if ai_interp.get("config_suggestion", {}).get("relevant"):
            existing = list_candidates(device_id, status="pending", limit=5)
            already_today = any(
                c.get("summary") == ai_interp["config_suggestion"].get("summary", "")
                for c in existing
            )
            if not already_today:
                cfg_sug = ai_interp["config_suggestion"]["params_to_adjust"]
                current = get_device_config(device_id)
                merged = dict(current)
                merged.update(cfg_sug)
                create_candidate(
                    device_id=device_id,
                    suggested_config=merged,
                    source="ai",
                    summary=ai_interp["config_suggestion"].get("summary", ""),
                    basis=[ai_interp["config_suggestion"].get("reason", "")],
                )

    return {
        "night_id": night_id,
        "date": summary.get("date", ""),
        "has_data": summary.get("event_count", 0) > 0,
        "event_count": summary.get("event_count", 0),
        "data_source": _event_data_source(events),
        "timeline": events,
        "reminder_stats": {
            "total_count": summary.get("total_rounds", 0),
            "success_count": summary.get("success_rounds", 0),
            "success_rate": summary.get("total_rounds", 0) and round(summary["success_rounds"] / summary["total_rounds"], 3) or 0,
            "avg_response_sec": summary.get("avg_response_time", 0),
            "max_level": summary.get("max_vibration_level", 0),
            "peak_hour": summary.get("peak_hour", ""),
        },
        "weekly_trend": weekly,
        "ai_interpretation": ai_interp,
        "source_tag": ai_interp.get("source", "rule_based") if generate_ai else "not_generated",
    }


# ═══════════════════════════════════════
# 七晚学习
# ═══════════════════════════════════════

@router.get("/weekly/{device_id}")
def weekly_report(
    device_id: str,
    days: int = 7,
    authorization: str = Header(default=""),
):
    """七晚趋势统计"""
    require_user_device_access(authorization, device_id)
    stats = get_weekly_stats(device_id, days)
    return stats


@router.post("/weekly/{device_id}/generate_candidate")
def generate_weekly_candidate(
    device_id: str,
    authorization: str = Header(default=""),
):
    """Generate a bounded candidate, using learned feedback after three nights."""
    require_user_device_access(authorization, device_id, write=True)
    weekly = get_weekly_stats(device_id, 7)
    current = get_device_config(device_id)
    from app.agent.bandit import BanditEngine, generate_bandit_candidate
    bandit = BanditEngine(device_id)
    if int(bandit.state.get("_nights", 0)) >= 3:
        candidate_id = generate_bandit_candidate(device_id)
    else:
        candidate_id = generate_ai_candidate(device_id, weekly, current)
    cand = get_candidate(candidate_id)
    return {"candidate_id": candidate_id, "candidate": cand}


# ═══════════════════════════════════════
# 候选配置（第 ⑤ 阶段核心）
# ═══════════════════════════════════════

@router.get("/candidates/{device_id}")
def candidates_list(
    device_id: str,
    status: str = None,
    authorization: str = Header(default=""),
):
    """候选配置列表"""
    require_user_device_access(authorization, device_id)
    return {"device_id": device_id, "candidates": list_candidates(device_id, status)}


class CandidateApproveRequest(BaseModel):
    idempotency_key: Optional[str] = None


@router.post("/candidates/{candidate_id}/approve")
async def candidate_approve(
    candidate_id: str,
    req: CandidateApproveRequest = None,
    authorization: str = Header(default=""),
):
    """
    用户确认 → 应用候选配置
    支持幂等键
    """
    candidate = get_candidate(candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="AI_CANDIDATE_NOT_FOUND")
    device_id = candidate["device_id"]
    require_user_device_access(authorization, device_id, write=True)
    return await apply_tonight_candidate(
        device_id,
        {
            "candidateId": candidate_id,
            "expectedConfigVersion": candidate["expected_config_version"],
        },
        authorization,
    )


@router.post("/candidates/{candidate_id}/reject")
def candidate_reject(
    candidate_id: str,
    authorization: str = Header(default=""),
):
    """用户拒绝"""
    candidate = get_candidate(candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="AI_CANDIDATE_NOT_FOUND")
    require_user_device_access(authorization, candidate["device_id"], write=True)
    return reject_candidate(candidate_id)


@router.get("/candidates/detail/{candidate_id}")
def candidate_detail(
    candidate_id: str,
    authorization: str = Header(default=""),
):
    """候选详情"""
    cand = get_candidate(candidate_id)
    if not cand:
        raise HTTPException(status_code=404, detail="not found")
    require_user_device_access(authorization, cand["device_id"])
    return cand


@router.get("/application_logs/{device_id}")
def application_logs(
    device_id: str,
    limit: int = 10,
    authorization: str = Header(default=""),
):
    """配置应用历史"""
    require_user_device_access(authorization, device_id)
    return {"device_id": device_id, "logs": get_application_log(device_id, limit)}


# ═══════════════════════════════════════
# 晨间反馈
# ═══════════════════════════════════════

class MorningFeedbackIn(BaseModel):
    device_id: str
    night_id: str = ""
    was_disturbed: bool = False
    morning_feeling: int = 3  # 1-5
    partner_affected: Optional[bool] = None
    comment: str = ""


@router.post("/morning_feedback")
def submit_morning_feedback(
    fb: MorningFeedbackIn,
    authorization: str = Header(default=""),
):
    """
    用户提交晨间反馈（是否被打扰 + 次日感受）
    用于校准七晚学习 —— 自动触发 Bandit 后验更新
    """
    if not 1 <= fb.morning_feeling <= 5 or len(fb.comment) > 1000:
        raise HTTPException(400, "morning_feeling 必须在 1-5，comment 最长 1000 字")
    user_id = require_user_device_access(authorization, fb.device_id, write=True)
    if not fb.night_id:
        fb.night_id = get_latest_night_id(fb.device_id) or get_night_id(fb.device_id)

    conn = get_conn()
    c = conn.cursor()
    now = int(datetime.now().timestamp())
    existing = c.execute(
        """SELECT id FROM morning_feedback
           WHERE device_id=? AND night_id=? AND (user_id=? OR user_id='')
           ORDER BY id DESC LIMIT 1""",
        (fb.device_id, fb.night_id, user_id),
    ).fetchone()
    partner = None if fb.partner_affected is None else int(fb.partner_affected)
    if existing:
        fid = existing["id"]
        c.execute(
            """UPDATE morning_feedback
               SET user_id=?,was_disturbed=?, morning_feeling=?, partner_affected=?, comment=?, created_at=?
               WHERE id=?""",
            (user_id, int(fb.was_disturbed), fb.morning_feeling, partner, fb.comment, now, fid),
        )
    else:
        c.execute('''INSERT INTO morning_feedback
                     (device_id,user_id,night_id,was_disturbed,morning_feeling,partner_affected,comment,created_at)
                     VALUES (?,?,?,?,?,?,?,?)''',
                  (fb.device_id, user_id, fb.night_id, int(fb.was_disturbed), fb.morning_feeling,
                   partner, fb.comment, now))
        fid = c.lastrowid
    conn.commit()
    conn.close()

    # ── Bandit 在线学习：反馈驱动后验更新 ──
    bandit_result = None
    try:
        # 取当晚摘要算 reward
        summary = get_daily_summary(fb.device_id, fb.night_id)
        total = summary.get("total_rounds", 0)
        success = summary.get("success_rounds", 0)
        success_rate = success / total if total > 0 else 0.0
        from app.agent.bandit import update_bandit_after_night
        bandit_result = update_bandit_after_night(
            device_id=fb.device_id,
            night_id=fb.night_id,
            success_rate=success_rate,
            avg_response_time=summary.get("avg_response_time", 0),
            was_disturbed=fb.was_disturbed,
            morning_feeling=fb.morning_feeling,
            rounds=total,
        )
    except Exception as e:
        bandit_result = {"error": str(e)}

    return {
        "status": "ok",
        "feedback_id": fid,
        "feedback": {
            "id": fid,
            "device_id": fb.device_id,
            "user_id": user_id,
            "night_id": fb.night_id,
            "was_disturbed": fb.was_disturbed,
            "morning_feeling": fb.morning_feeling,
            "partner_affected": fb.partner_affected,
            "comment": fb.comment,
            "created_at": now,
        },
        "bandit_update": bandit_result,
    }


@router.get("/morning_feedback/{device_id}")
def list_feedback(
    device_id: str,
    limit: int = 7,
    authorization: str = Header(default=""),
):
    """获取最近的反馈"""
    user_id = require_user_device_access(authorization, device_id)
    conn = get_conn()
    c = conn.cursor()
    limit = max(1, min(int(limit or 7), 100))
    c.execute(
        """SELECT f.* FROM morning_feedback f
           JOIN (
             SELECT MAX(id) AS id FROM morning_feedback
             WHERE device_id=? AND (user_id=? OR user_id='') GROUP BY night_id
           ) latest ON latest.id=f.id
           ORDER BY f.created_at DESC, f.id DESC LIMIT ?""",
        (device_id, user_id, limit),
    )
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return {"device_id": device_id, "feedbacks": rows}


# ═══════════════════════════════════════
# Bandit 在线学习（AI 自主控制核心）
# ═══════════════════════════════════════

@router.get("/bandit/{device_id}/status")
async def bandit_status(device_id: str, authorization: str = Header(default="")):
    """Bandit 学习状态：后验分布 + 学习曲线（演示用）"""
    require_user_device_access(authorization, device_id)
    from app.agent.bandit import BanditEngine
    bandit = BanditEngine(device_id)
    return {
        "device_id": device_id,
        "nights_tracked": bandit.state.get("_nights", 0),
        "posterior": bandit.get_posterior_summary(),
        "learning_curve": bandit.get_learning_curve(),
    }


@router.post("/bandit/{device_id}/sample")
async def bandit_sample(device_id: str, authorization: str = Header(default="")):
    """Thompson 采样生成候选配置（Agent 自主决策的体现）"""
    require_user_device_access(authorization, device_id, write=True)
    from app.agent.bandit import generate_bandit_candidate
    candidate_id = generate_bandit_candidate(device_id)
    from app.agent.candidates import get_candidate
    cand = get_candidate(candidate_id)
    return {"candidate_id": candidate_id, "candidate": cand}


@router.post("/bandit/{device_id}/reset")
async def bandit_reset(device_id: str, authorization: str = Header(default="")):
    """重置学习状态（调试用）"""
    _require_cloud_agent_debug()
    require_user_device_access(authorization, device_id, write=True)
    from app.agent.bandit import BanditEngine
    BanditEngine(device_id).reset()
    return {"status": "reset"}


# ═══════════════════════════════════════
# 小程序 AI 对话 + 解读（9/5 接入）
# ═══════════════════════════════════════

class AIChatIn(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)
    interpretation_id: str = Field(default="", max_length=256)
    chat_history: Optional[List[Dict[str, str]]] = Field(default=None, max_length=20)


class SimulatedDataSeedIn(BaseModel):
    confirm_simulated: bool = False
    days: int = Field(default=7, ge=1, le=7)



# ═══════════════════════════════════════
# 设备声音 / 灯光状态
# ═══════════════════════════════════════

# ═══════════════════════════════════════
# 演示态控制（模拟设备在线/未配网/失联/升级中等状态机）
# 内存存储，重启后重置（与 mock 行为一致）
# ═══════════════════════════════════════

_DEMO_DEFAULT = {
    "offline": False,
    "unprovisioned": False,
    "padDisconnected": False,
    "noData": False,
    "syncFailed": False,
    "highAttention": False,
    "firmwareUpdate": False,
    "modelUpdate": True,
    "commandOutcome": "applied",  # applied | readback-timeout | readback-mismatch
}
_DEMO_STATES: dict[str, dict] = {}


@router.get("/device/{device_id}/demo-states")
async def get_device_demo_states(
    device_id: str,
    authorization: str = Header(default=""),
):
    _require_cloud_agent_debug()
    require_user_device_access(authorization, device_id)
    if device_id not in _DEMO_STATES:
        _DEMO_STATES[device_id] = dict(_DEMO_DEFAULT)
    return {"device_id": device_id, "demoStates": _DEMO_STATES[device_id]}


@router.put("/device/{device_id}/demo-states")
async def set_device_demo_state(
    device_id: str,
    patch: dict,
    authorization: str = Header(default=""),
):
    """设置某个 demo state 维度（offline / unprovisioned / pad-disconnected ...）"""
    _require_cloud_agent_debug()
    require_user_device_access(authorization, device_id, write=True)
    if device_id not in _DEMO_STATES:
        _DEMO_STATES[device_id] = dict(_DEMO_DEFAULT)
    states = _DEMO_STATES[device_id]
    kind = patch.get("kind")
    enabled = patch.get("enabled", False)
    if not kind:
        raise HTTPException(400, "kind 必填")

    if kind == "command-outcome":
        allowed = ("applied", "readback-timeout", "readback-mismatch")
        states["commandOutcome"] = enabled if enabled in allowed else "applied"
    else:
        key_map = {
            "offline": "offline",
            "unprovisioned": "unprovisioned",
            "pad-disconnected": "padDisconnected",
            "no-data": "noData",
            "sync-failed": "syncFailed",
            "high-attention": "highAttention",
            "firmware-update": "firmwareUpdate",
            "model-update": "modelUpdate",
        }
        if kind not in key_map:
            raise HTTPException(400, f"kind 非法: {kind}")
        states[key_map[kind]] = bool(enabled)
    return {"device_id": device_id, "demoStates": states}


# ═══════════════════════════════════════
# Settings Command 状态机（持久命令 → 设备 ACK → readback 核对）
# ═══════════════════════════════════════

def _public_persisted_command(command: dict) -> dict:
    payload = command.get("payload") or {}
    readback = command.get("readback") or {}
    status = command.get("status") or "pending"
    ack_status = (
        "waiting" if status == "pending"
        else "accepted" if status in {"delivered", "applied"}
        else "rejected"
    )
    matches_candidate = (
        True if status == "applied"
        else False if status == "readback-mismatch"
        else None
    )
    return {
        "commandId": command.get("command_id", ""),
        "idempotencyKey": command.get("idempotency_key", ""),
        "candidateId": payload.get("candidate_id", ""),
        "expectedConfigVersion": command.get("expected_config_version", 0),
        "createdAt": command.get("created_at", 0),
        "expiresAt": command.get("expires_at", 0),
        "status": status,
        "ackStatus": ack_status,
        "ackAt": command.get("acknowledged_at") or None,
        "errorCode": command.get("error_code") or None,
        "fieldErrors": [],
        "readbackAt": command.get("acknowledged_at") or None,
        "readbackSettings": readback.get("config"),
        "readbackConfigVersion": readback.get("config_version"),
        "matchesCandidate": matches_candidate,
    }


@router.get("/device/{device_id}/settings-command/active")
async def get_active_settings_command(
    device_id: str,
    authorization: str = Header(default=""),
):
    """Return the latest durable config command, including terminal readback."""
    require_user_device_access(authorization, device_id)
    from fastapi.responses import JSONResponse
    cmd = get_active_device_command(device_id, "apply_config")
    if not cmd:
        return JSONResponse({"device_id": device_id, "command": None})
    return {"device_id": device_id, "command": _public_persisted_command(cmd)}


@router.get("/device/{device_id}/settings-command/{command_id}")
async def get_settings_command(
    device_id: str,
    command_id: str,
    authorization: str = Header(default=""),
):
    """Read a command without fabricating device progress."""
    require_user_device_access(authorization, device_id)
    cmd = get_device_command(command_id)
    if not cmd or cmd.get("device_id") != device_id:
        raise HTTPException(404, "SETTINGS_COMMAND_NOT_FOUND")
    return {"device_id": device_id, "command": _public_persisted_command(cmd)}


@router.post("/device/{device_id}/settings-command/{command_id}/reconcile")
async def reconcile_settings_command(
    device_id: str,
    command_id: str,
    payload: dict | None = None,
    authorization: str = Header(default=""),
):
    """Requeue a failed readback; the device must poll and acknowledge again."""
    require_user_device_access(authorization, device_id, write=True)
    try:
        cmd = requeue_device_command(device_id, command_id)
    except ValueError as error:
        raise HTTPException(404, "SETTINGS_COMMAND_NOT_FOUND") from error
    return {"device_id": device_id, "command": _public_persisted_command(cmd)}


@router.post("/device/{device_id}/apply-candidate")
async def apply_tonight_candidate(
    device_id: str,
    payload: dict,
    authorization: str = Header(default=""),
):
    """Queue a candidate; it is committed only after physical-device readback."""
    require_user_device_access(authorization, device_id, write=True)
    from app.database import get_device
    from app.agent.candidates import get_candidate

    if not get_device(device_id):
        raise HTTPException(404, "DEVICE_NOT_FOUND")

    candidate_id = payload.get("candidateId") if payload else None
    expected_config_version = payload.get("expectedConfigVersion") if payload else None
    if not candidate_id or expected_config_version is None:
        raise HTTPException(400, "candidateId 与 expectedConfigVersion 必填")

    # 1. 取 candidate
    cand = get_candidate(candidate_id)
    if not cand:
        raise HTTPException(404, "AI_CANDIDATE_NOT_FOUND")
    if cand.get("device_id") != device_id:
        raise HTTPException(404, "AI_CANDIDATE_NOT_FOUND")

    # 2. 校验 config version（与前端契约 currentConfigVersion 对齐）
    device_row = get_device(device_id)
    current_version = device_row.get("config_version", 0) if device_row else 0
    if cand.get("status") not in {"pending", "applied"}:
        raise HTTPException(409, f"AI_CANDIDATE_{str(cand.get('status') or 'INVALID').upper()}")
    if cand.get("status") != "applied" and current_version != expected_config_version:
        raise HTTPException(409, f"CONFIG_CONFLICT: 期望 {expected_config_version} 当前 {current_version}")

    # 3. Persist the command. The device applies it locally and ACKs with its
    # readback; only then does the ACK endpoint commit the candidate.
    idempotency_key = f"apply:{device_id}:{candidate_id}:{expected_config_version}"
    command = await run_in_threadpool(
        create_device_command,
        device_id,
        "apply_config",
        {
            "candidate_id": candidate_id,
            "settings": cand.get("suggested_config") or {},
            "target_config_version": current_version + (0 if cand.get("status") == "applied" else 1),
        },
        current_version,
        idempotency_key,
        600,
    )
    if command["status"] in {"expired", "failed", "rejected", "readback-mismatch"}:
        command = await run_in_threadpool(
            requeue_device_command,
            device_id,
            command["command_id"],
            600,
        )
    return {"device_id": device_id, "command": _public_persisted_command(command)}


# ═══════════════════════════════════════
# AI chat / interpretation（兼容层）
# 兼容旧路径，确保前端统一前缀 /api/v1
# ═══════════════════════════════════════


@router.get("/device/{device_id}/sound")
def get_device_sound(device_id: str, authorization: str = Header(default="")):
    from app.database import get_sound_state, get_device, upsert_device
    require_user_device_access(authorization, device_id)
    if not get_device(device_id):
        upsert_device(device_id)
    return {"device_id": device_id, "sound": get_sound_state(device_id)}


@router.put("/device/{device_id}/sound")
def update_device_sound(
    device_id: str,
    patch: dict,
    authorization: str = Header(default=""),
):
    from fastapi import HTTPException
    from app.database import set_sound_state, get_device, upsert_device
    require_user_device_access(authorization, device_id, write=True)
    if not get_device(device_id):
        upsert_device(device_id)
    # 字段白名单 + 限幅
    allowed = {"scene", "sceneName", "trackName", "playing", "volume", "timer", "fadeSeconds", "scenes"}
    safe = {k: v for k, v in (patch or {}).items() if k in allowed}
    if "volume" in safe:
        v = int(safe["volume"])
        if v < 0 or v > 100:
            raise HTTPException(400, "volume 必须在 0-100")
    if "scene" in safe and safe["scene"] not in ("sleep", "healing", "work", "reading"):
        raise HTTPException(400, f"scene 非法: {safe['scene']}")
    if "timer" in safe and safe["timer"] not in (15, 30, 60, "all-night"):
        raise HTTPException(400, f"timer 非法: {safe['timer']}")
    return {"device_id": device_id, "sound": set_sound_state(device_id, safe)}


@router.get("/device/{device_id}/light")
def get_device_light(device_id: str, authorization: str = Header(default="")):
    from app.database import get_light_state, get_device, upsert_device
    require_user_device_access(authorization, device_id)
    if not get_device(device_id):
        upsert_device(device_id)
    return {"device_id": device_id, "light": get_light_state(device_id)}


@router.put("/device/{device_id}/light")
def update_device_light(
    device_id: str,
    patch: dict,
    authorization: str = Header(default=""),
):
    from fastapi import HTTPException
    from app.database import set_light_state, get_device, upsert_device
    require_user_device_access(authorization, device_id, write=True)
    if not get_device(device_id):
        upsert_device(device_id)
    allowed = {"enabled", "mode", "modeName", "brightness", "color"}
    safe = {k: v for k, v in (patch or {}).items() if k in allowed}
    if "brightness" in safe:
        b = int(safe["brightness"])
        if b < 5 or b > 40:
            raise HTTPException(400, "brightness 必须在 5-40")
    if "mode" in safe and safe["mode"] not in ("bedtime-breathe", "night-low"):
        raise HTTPException(400, f"mode 非法: {safe['mode']}")
    if "color" in safe and safe["color"] not in ("amber", "warm-amber", "warm-yellow"):
        raise HTTPException(400, "灯光颜色仅支持暖琥珀色")
    return {"device_id": device_id, "light": set_light_state(device_id, safe)}


# ═══════════════════════════════════════
# AI chat / interpretation（兼容层）
# 兼容旧路径，确保前端统一前缀 /api/v1
# ═══════════════════════════════════════

@router.post("/ai/chat")
async def ai_chat(
    body: AIChatIn,
    authorization: str = Header(default=""),
):
    """
    小程序 AI 对话接口：
    - 接收用户消息 + 可选的解读上下文
    - 调用 LLM 生成回复
    - 自动注入报告上下文 + 7 晚趋势 + 合规约束
    """
    if not body.message or not body.message.strip():
        raise HTTPException(400, "message 不能为空")
    require_user_device_access(authorization, body.device_id)

    # 1. 拉取报告上下文
    night_id = get_latest_night_id(body.device_id) or get_night_id(body.device_id)
    summary, weekly = await asyncio.gather(
        run_in_threadpool(compute_daily_summary, body.device_id, night_id),
        run_in_threadpool(get_weekly_stats, body.device_id, 7),
    )
    ctx = build_report_context(summary, weekly)

    # 2. 拉取最近反馈
    from app.database import get_recent_feedback
    ctx["recent_feedback"] = await run_in_threadpool(get_recent_feedback, body.device_id, 3)

    # 3. 构造 chat 上下文
    messages = body.chat_history or []
    messages = [
        {"role": m.get("role"), "content": str(m.get("content", ""))[:2000]}
        for m in messages
        if m.get("role") in {"user", "assistant"} and m.get("content")
    ]

    system_prompt = f"""你是酣眠 SnoozMate 的睡眠健康助手，正在和用户对话。

合规要求（必须严格遵守）：
- 绝对不能说：守护、监测、引导翻身、止鼾、筛查、分级、AHI、治疗、提高
- 必须用：观察、记录、趋势、轻柔提示、响应率、建议就医
- 不做医疗诊断，不是医疗器械，只提供睡眠健康趋势观察
- 不能建议用药、停药、调整剂量
- 紧急情况（如胸痛、呼吸困难）必须立即建议联系急救

用户当前的睡眠数据背景：
{json.dumps(ctx, ensure_ascii=False, indent=2)}

回答要求：
- 必须使用简体中文，直接回答用户问题，不要输出英文
- 语气温暖、安心，让用户感到"被陪伴"而不是"被监督"
- 回答 50-150 字
- 可以引用具体数据（如"昨晚 12 次温和提醒，成功 3 次"）
- 不要重复 system 里的数据，除非有必要
- 如果 `has_data=false`，直接回答用户的具体问题，并明确没有可引用的昨夜记录；
  不要输出与提问无关的固定模板，也不要凭空推断睡眠状态
- 如果用户问紧急/医疗/用药问题，按安全规则处理"""

    messages.insert(0, {"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": body.message})

    # 4. Async LLM call with bounded connect/read/overall time and deterministic fallback.
    from app import config
    ctx_fp = hashlib.md5(json.dumps(ctx, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:8]
    conversation_fp = hashlib.md5(
        json.dumps(messages, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()[:10]
    chat_cache_key = f"chat:{body.device_id}:{ctx_fp}:{conversation_fp}"
    cached_chat = _morning_report_cache.get(chat_cache_key)
    if cached_chat and (time.time() - cached_chat["ts"]) < 1800:
        return cached_chat["data"]
    if not config.LLM_API_KEY:
        return {
            "status": "fallback",
            **generate_chat_fallback(body.message, ctx),
            "source": "rule_based",
            "model_provider": config.LLM_PROVIDER,
        }
    try:
        text = await request_llm_chat(messages, max_tokens=400)
        fallback = generate_chat_fallback(body.message, ctx)
        if has_unsafe_medical_instruction(text):
            return {
                "status": "fallback",
                **fallback,
                "source": "rule_based_safety_fallback",
                "model_provider": config.LLM_PROVIDER,
            }
        text = normalize_llm_chat_reply(text)
        if claims_no_record(text) and ctx["daily_summary"]["event_count"] > 0:
            text = fallback["answer"]
            grounded = True
        else:
            grounded = False
        result = {
            "status": "ok",
            "answer": text,
            "sections": fallback["sections"],
            "answer_kind": fallback["answer_kind"],
            "safety_class": fallback["safety_class"],
            "source": "llm",
            "model_provider": config.LLM_PROVIDER,
            "grounded_by_rules": grounded,
            "context_used": {
                "night_id": night_id,
                "weekly_nights": weekly.get("nights", 0),
                "success_rate": ctx["daily_summary"]["success_rate"],
            },
        }
        _morning_report_cache[chat_cache_key] = {"ts": time.time(), "data": result}
        return result
    except (httpx.HTTPError, asyncio.TimeoutError, KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="AI_MODEL_UNAVAILABLE") from error


@router.post("/device/{device_id}/simulated-data")
async def seed_simulated_data(
    device_id: str,
    body: SimulatedDataSeedIn,
    authorization: str = Header(default=""),
):
    """Create clearly labelled experience data only after explicit confirmation."""
    require_user_device_access(authorization, device_id, write=True)
    if not app_config.ALLOW_SIMULATED_EXPERIENCE_DATA:
        raise HTTPException(status_code=403, detail="SIMULATED_DATA_DISABLED")
    if not body.confirm_simulated:
        raise HTTPException(status_code=400, detail="SIMULATED_DATA_CONFIRMATION_REQUIRED")
    from app.demo_data import seed_simulated_experience_data
    result = await run_in_threadpool(
        seed_simulated_experience_data,
        device_id,
        body.days,
    )
    if result.get("reason") == "real_device_data_exists":
        raise HTTPException(status_code=409, detail="REAL_DEVICE_DATA_EXISTS")
    if result.get("seeded"):
        stale_keys = [
            key
            for key in _morning_report_cache
            if device_id in key
        ]
        for key in stale_keys:
            _morning_report_cache.pop(key, None)
    return result


@router.get("/ai/interpretation/{device_id}")
async def get_ai_interpretation(
    device_id: str,
    night_id: str = "",
    refresh: bool = False,
    authorization: str = Header(default=""),
):
    """
    解耦版 AI 解读（不依赖完整 morning_report）
    小程序首次进入 AI 页面时调用
    """
    require_user_device_access(authorization, device_id)
    if not night_id:
        night_id = get_latest_night_id(device_id) or get_night_id(device_id)

    summary, weekly = await asyncio.gather(
        run_in_threadpool(compute_daily_summary, device_id, night_id),
        run_in_threadpool(get_weekly_stats, device_id, 7),
    )
    ctx = build_report_context(summary, weekly)
    stored = {} if refresh else await run_in_threadpool(get_saved_ai_interpretation, device_id, night_id)
    ai_interp = ground_ai_interpretation(stored, ctx) if stored else {}
    if not ai_interp:
        ai_interp = await generate_ai_interpretation(ctx)
    if ai_interp.get("source") == "llm":
        await run_in_threadpool(save_ai_interpretation, device_id, night_id, ai_interp)

    return {
        "device_id": device_id,
        "night_id": night_id,
        "date": summary.get("date", ""),
        "has_data": summary.get("event_count", 0) > 0,
        "event_count": summary.get("event_count", 0),
        "weekly": weekly,
        "ai_interpretation": ai_interp,
        "source_tag": ai_interp.get("source", "rule_based"),
    }
