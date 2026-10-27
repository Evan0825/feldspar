"""
SnoozMate Agent 决策引擎 —— 产品灵魂
核心：五问循环 + 预算管理 + 冷却机制 + 验证反馈 + 七晚学习

不是"检测到就动"的自动化，而是有判断力的 Agent。
"""
import time
import json
import uuid
from typing import Dict, Optional, List
from dataclasses import asdict, dataclass, field


@dataclass
class AgentState:
    """Agent 状态机状态"""
    state: str = "STANDBY"  # STANDBY / MONITORING / CONFIRMING / INTERVENTION / VERIFYING / COOLDOWN
    rounds_done: int = 0
    current_level: int = 0
    intervention_start_time: float = 0
    last_intervention_time: float = 0
    snore_streak_seconds: float = 0    # 连续鼾声累计时长
    bed_time: float = 0                # 入睡时间（用于入睡保护）
    # 验证窗口数据
    verify_start_time: float = 0       # 验证窗口起始时间
    verification_pause_started_at: float = 0
    verify_snore_stopped: bool = False
    verify_body_moved: bool = False
    low_confidence_seconds: float = 0
    budget_notified: bool = False      # 预算耗尽只提醒一次
    active_cycle_id: str = ""
    sequence: int = 0
    partner_mode: bool = False
    # 七晚学习结果
    weekly_stats: dict = field(default_factory=dict)


class SnoozMateAgent:
    """
    好眠 Agent —— 有分寸感的睡眠守护者

    五问循环（每 1 秒执行一次）：
      1. 人在床上吗？
      2. 是连续周期性鼾声吗？
      3. 冷却期过了吗？
      4. 今晚预算够吗？
      5. 硬件安全吗？

    都通过 → 启动干预（从起始等级开始，渐进升级）
    否则 → 选择不干预，并记录原因
    """

    def __init__(self, config: dict, device_id: str = "dev_001"):
        self.config = config
        self.device_id = device_id
        self.state = AgentState()
        self.decision_log = []  # 决策日志，用于可视化时间轴
        self._pending_events = []

    def _log(self, level: str, msg: str, data: dict = None):
        """记录决策过程（供大屏可视化用）"""
        entry = {
            "time": time.strftime("%H:%M:%S"),
            "ts": time.time(),
            "level": level,      # info / warn / action / success / skip
            "message": msg,
            "data": data or {},
            "state": self.state.state,
            "rounds_done": self.state.rounds_done,
            "rounds_remaining": max(0, self._max_rounds() - self.state.rounds_done),
        }
        self.decision_log.append(entry)
        # 只保留最近 200 条
        if len(self.decision_log) > 200:
            self.decision_log = self.decision_log[-200:]
        return entry

    def _max_rounds(self) -> int:
        return int(
            self.config["partner_mode_max_rounds"]
            if self.state.partner_mode
            else self.config["max_rounds_per_night"]
        )

    def _emit(self, event_type: str, now: float, **values):
        event = {
            "device_id": self.device_id,
            "timestamp": int(now),
            "event_type": event_type,
            "round_in_night": self.state.rounds_done,
            "vibration_level": self.state.current_level,
            "model_version": "agent_v2",
            **values,
        }
        self._pending_events.append(event)
        return event

    def drain_events(self) -> List[dict]:
        events = self._pending_events
        self._pending_events = []
        return events

    def export_state(self) -> dict:
        """Serializable state for device-side non-volatile storage."""
        return asdict(self.state)

    def restore_state(self, payload: dict):
        """Restore only known fields so old firmware state remains compatible."""
        if not isinstance(payload, dict):
            return
        known = AgentState.__dataclass_fields__
        values = {key: payload[key] for key in known if key in payload}
        self.state = AgentState(**values)

    def _result(self, action: str, reason: str, level: int = 0, **extra) -> Dict:
        self.state.sequence += 1
        return {
            "action": action,
            "reason": reason,
            "level": level,
            "cycle_id": self.state.active_cycle_id or None,
            "sequence": self.state.sequence,
            **extra,
        }

    def process_tick(self, audio_confidence: float, in_bed: bool,
                     body_motion_level: float, temp_ok: bool = True,
                     hardware_ready: bool = True, is_partner: bool = False,
                     elapsed_seconds: float = 1.0,
                     now: Optional[float] = None) -> Dict:
        """
        每 tick 处理一次传感器数据（建议 1Hz）
        返回：{"action": ..., "reason": ..., "level": ..., "log_entry": ...}
        """
        now = time.time() if now is None else float(now)
        elapsed_seconds = max(0.1, min(float(elapsed_seconds), 5.0))
        cfg = self.config
        self.state.partner_mode = bool(is_partner)

        # === 第一问：人在床上吗？（雷达门控）===
        if not in_bed:
            was_active = self.state.state in ("INTERVENTION", "VERIFYING")
            if was_active:
                self._emit("vibration_stop", now, result="out_of_bed")
            if self.state.bed_time:
                self._emit("wake_up", now, in_bed=False)
            if self.state.state != "STANDBY":
                self.state.state = "STANDBY"
                self.state.snore_streak_seconds = 0
                self.state.low_confidence_seconds = 0
                self.state.verification_pause_started_at = 0
                self.state.active_cycle_id = ""
                self._log("info", "🛏️  无人在床，进入待机")
            self.state.bed_time = 0
            return self._result("STOP" if was_active else "NONE", "无人在床", 0)

        if not self.state.bed_time:
            self.notify_bedtime(now=now)

        # 入睡保护：上床后 15 分钟内不干预
        if now - self.state.bed_time < cfg["fall_asleep_protection"]:
            remaining = int(cfg["fall_asleep_protection"] - (now - self.state.bed_time))
            return self._result("NONE", f"入睡保护中（剩{remaining}秒）", 0)

        if not temp_ok or not hardware_ready:
            was_active = self.state.state in ("INTERVENTION", "VERIFYING")
            if was_active:
                self._emit(
                    "vibration_stop",
                    now,
                    result="temperature_lock" if not temp_ok else "hardware_lock",
                    error_code=1 if not temp_ok else 2,
                )
            self.state.state = "SAFETY_LOCKED"
            self.state.snore_streak_seconds = 0
            self.state.low_confidence_seconds = 0
            self.state.verification_pause_started_at = 0
            self.state.active_cycle_id = ""
            reason = "温度异常，安全锁定" if not temp_ok else "传感器或振动片未就绪，安全锁定"
            self._log(
                "warn",
                f"🌡️  {reason}",
                {"temp_ok": temp_ok, "hardware_ready": hardware_ready},
            )
            return self._result("STOP" if was_active else "NONE", reason, 0)

        if self.state.state == "SAFETY_LOCKED":
            self.state.state = "MONITORING"
            self._log("info", "温度恢复正常，重新进入观察")

        # 干预期间，明显体动优先判定为响应成功并立即停止。
        motion_threshold = float(cfg.get("body_motion_success_threshold", 0.65))
        if self.state.state in ("INTERVENTION", "VERIFYING") and body_motion_level >= motion_threshold:
            self.report_body_moved(now=now)
            return self._result("STOP", "检测到明显体动，停止提醒并进入冷却", 0)

        # Check the deadline before any confidence/budget branch can return.
        if self.state.state == "INTERVENTION":
            elapsed_ms = (now - self.state.intervention_start_time) * 1000
            if elapsed_ms >= cfg["max_vibration_duration_ms"]:
                stopped_level = self.state.current_level
                self._emit("vibration_stop", now, result="duration_limit")
                self._enter_cooldown("单次时长超限，停止", now=now)
                return self._result("STOP", "单次最长时间保护", stopped_level)

        # 干预期间连续低置信度表示声音趋势已经回落，先停止振动再验证。
        if self.state.state == "INTERVENTION":
            if audio_confidence < cfg["snore_confidence_threshold"]:
                self.state.low_confidence_seconds += elapsed_seconds
                if self.state.low_confidence_seconds >= float(cfg.get("snore_stop_confirm_seconds", 3)):
                    self.report_snore_stopped(now=now)
                    return self._result("PAUSE", "声音趋势已回落，停止振动并验证", 0)
                return self._result(
                    f"VIBRATE_L{self.state.current_level}",
                    "声音趋势回落确认中，保持当前强度",
                    self.state.current_level,
                    elapsed_ms=int((now - self.state.intervention_start_time) * 1000),
                )
            else:
                self.state.low_confidence_seconds = 0

        # === 第二问：是连续周期性鼾声吗？===
        if audio_confidence >= cfg["snore_confidence_threshold"]:
            self.state.snore_streak_seconds += elapsed_seconds
        else:
            # 衰减：不是连续的话慢慢减
            self.state.snore_streak_seconds = max(
                0, self.state.snore_streak_seconds - (0.5 * elapsed_seconds)
            )

        # 还没到确认时长
        if self.state.snore_streak_seconds < cfg["snore_confirm_seconds"]:
            if self.state.state == "INTERVENTION" or self.state.state == "VERIFYING":
                # 干预中或验证中，继续往下走（验证鼾声是否停止）
                pass
            else:
                # 注意：不能覆盖 COOLDOWN —— 冷却期内保持冷却状态，
                # 否则下面的冷却检查会被绕过，冷却机制失效
                if self.state.state != "COOLDOWN":
                    self.state.state = (
                        "CONFIRMING"
                        if self.state.snore_streak_seconds > 0
                        else "MONITORING"
                    )
                return self._result(
                    "MONITOR",
                    f"观察中，连续鼾声 {self.state.snore_streak_seconds:.0f}/{cfg['snore_confirm_seconds']}秒",
                    0,
                    confidence=audio_confidence,
                )

        # === 第三问：冷却期过了吗？===
        if self.state.state == "COOLDOWN":
            elapsed = now - self.state.last_intervention_time
            if elapsed < cfg["cooldown_seconds"]:
                remaining = int(cfg["cooldown_seconds"] - elapsed)
                return self._result("NONE", f"冷却中（剩{remaining}秒）", 0)
            self.state.state = "MONITORING"
            self._log("info", "⏳ 冷却结束，恢复观察")

        # === 第四问：今晚预算用完了吗？===
        max_rounds = self._max_rounds()
        # A round consumes its budget when it starts; its execution and
        # verification must still reach the normal stop path.
        if self.state.rounds_done >= max_rounds and self.state.state not in ("INTERVENTION", "VERIFYING"):
            if not self.state.budget_notified:
                self._log("skip", "🛑 今夜预算用完，选择不干预",
                          {"rounds_done": self.state.rounds_done, "max": max_rounds})
                self.state.budget_notified = True
                self.state.state = "COOLDOWN"  # 进入"终局冷却"
            return self._result(
                "NONE",
                f"今夜预算用完（{self.state.rounds_done}/{max_rounds}轮）",
                0,
            )

        # === 全过 → 启动干预 ===
        if self.state.state not in ("INTERVENTION", "VERIFYING"):
            self.state.state = "INTERVENTION"
            self.state.current_level = cfg["start_vibration_level"]
            self.state.intervention_start_time = now
            self.state.rounds_done += 1
            self.state.active_cycle_id = f"cycle_{uuid.uuid4().hex[:12]}"
            self.state.budget_notified = False
            self.state.verify_snore_stopped = False
            self.state.verify_body_moved = False
            self.state.low_confidence_seconds = 0
            self._emit(
                "snore_detected",
                now,
                snore_confidence=audio_confidence,
            )
            self._emit(
                "intervention",
                now,
                vibration_level=self.state.current_level,
                result="started",
            )
            self._log("action", f"✅ 五问全过 → 第{self.state.rounds_done}轮 L{self.state.current_level} 振动启动",
                      {"round": self.state.rounds_done,
                       "level": self.state.current_level,
                       "remaining": max_rounds - self.state.rounds_done})

        # ── 验证窗口：鼾声已停 → 停止振动，等体动确认 ──
        if self.state.state == "VERIFYING":
            # 鼾声又响了 → 恢复振动（回到干预状态）
            if audio_confidence >= cfg["snore_confidence_threshold"]:
                paused_seconds = max(0, now - self.state.verification_pause_started_at)
                self.state.intervention_start_time += paused_seconds
                self.state.verification_pause_started_at = 0
                self.state.state = "INTERVENTION"
                self.state.low_confidence_seconds = 0
                self._log("action", "🔁 验证期间鼾声复发，恢复振动")
                # 落到下面继续走干预升级逻辑
            else:
                verify_elapsed = now - self.state.verify_start_time
                if verify_elapsed >= cfg["verify_window_seconds"]:
                    # 窗口内没有体动 → 按鼾声已停处理，进入冷却
                    response_time = max(0, now - self.state.intervention_start_time)
                    self._emit(
                        "verification_success",
                        now,
                        result="success",
                        response_time_sec=round(response_time, 1),
                        note="snore_stopped",
                    )
                    self._enter_cooldown("验证窗口结束（声音趋势已回落）", now=now)
                    return self._result("STOP", "验证窗口结束，进入冷却", 0)
                # 验证期间不再振动、不升级
                return self._result(
                    "PAUSE",
                    f"声音趋势已回落，验证中（{int(cfg['verify_window_seconds'] - verify_elapsed)}秒）",
                    0,
                )

        # 干预中：判断是否需要升级
        elapsed_ms = (now - self.state.intervention_start_time) * 1000
        upgrade_steps = int(elapsed_ms / cfg["upgrade_interval_ms"])
        new_level = min(
            cfg["start_vibration_level"] + upgrade_steps,
            max(cfg["start_vibration_level"], cfg.get("max_vibration_level", 3)),
        )

        if new_level > self.state.current_level:
            self.state.current_level = new_level
            self._emit(
                "vibration_level_change",
                now,
                vibration_level=new_level,
                result="escalated",
            )
            self._log("action", f"⬆️ 升级到 L{new_level}",
                      {"level": new_level, "elapsed_ms": int(elapsed_ms)})

        return self._result(
            f"VIBRATE_L{self.state.current_level}",
            f"第{self.state.rounds_done}轮干预中",
            self.state.current_level,
            elapsed_ms=int(elapsed_ms),
        )

    def report_snore_stopped(self, now: Optional[float] = None):
        """硬件检测到鼾声停止 → 进入验证窗口"""
        if self.state.state == "INTERVENTION":
            now = time.time() if now is None else float(now)
            self.state.state = "VERIFYING"
            self.state.verify_start_time = now
            self.state.verification_pause_started_at = now
            self.state.verify_snore_stopped = True
            self.state.low_confidence_seconds = 0
            self._emit("snore_stop", now, result="observed")
            self._emit("vibration_stop", now, result="verifying")
            self._log("info", "🔇 鼾声停止，停止振动，验证中...")

    def report_body_moved(self, now: Optional[float] = None):
        """检测到明显体动 → 验证成功"""
        now = time.time() if now is None else float(now)
        self.state.verify_body_moved = True
        if self.state.state in ("INTERVENTION", "VERIFYING"):
            response_time = max(0, now - self.state.intervention_start_time)
            self._emit(
                "position_change",
                now,
                result="success",
                response_time_sec=round(response_time, 1),
            )
            self._emit(
                "vibration_stop",
                now,
                result="success",
                response_time_sec=round(response_time, 1),
            )
            self._enter_cooldown("检测到体动，干预成功", now=now)
            return True
        return False

    def _enter_cooldown(self, reason: str, now: Optional[float] = None):
        """进入冷却期"""
        now = time.time() if now is None else float(now)
        self.state.state = "COOLDOWN"
        self.state.last_intervention_time = now
        self.state.snore_streak_seconds = 0
        self.state.low_confidence_seconds = 0
        self.state.verification_pause_started_at = 0
        self.state.verify_snore_stopped = False
        self.state.verify_body_moved = False
        self._log("success", f"✨ {reason} → 进入冷却",
                  {"round": self.state.rounds_done,
                   "level_used": self.state.current_level})
        self.state.current_level = 0
        self.state.active_cycle_id = ""

    def notify_bedtime(self, now: Optional[float] = None):
        """检测到用户上床 → 重置状态，启动入睡保护"""
        now = time.time() if now is None else float(now)
        self.state.bed_time = now
        self.state.state = "STANDBY"
        self.state.snore_streak_seconds = 0
        self.state.low_confidence_seconds = 0
        self.state.verification_pause_started_at = 0
        self._emit("in_bed", now, in_bed=True)
        minutes = int(self.config.get("fall_asleep_protection", 0) / 60)
        self._log("info", f"🛌 检测到上床，进入入睡保护（{minutes}分钟）")

    def force_stop(self, reason: str = "用户停止", now: Optional[float] = None) -> bool:
        now = time.time() if now is None else float(now)
        if self.state.state not in ("INTERVENTION", "VERIFYING"):
            return False
        self._emit("vibration_stop", now, result="manual_stop", note=reason)
        self._enter_cooldown(reason, now=now)
        return True

    def reset_night(self):
        """新的一夜 → 重置计数"""
        self.state.rounds_done = 0
        self.state.state = "STANDBY"
        self.state.current_level = 0
        self.state.snore_streak_seconds = 0
        self.state.low_confidence_seconds = 0
        self.state.verification_pause_started_at = 0
        self.state.active_cycle_id = ""
        self.state.bed_time = 0
        self._log("info", "🌙 新的一夜，状态重置")

    def get_status(self) -> dict:
        """获取当前 Agent 状态（供前端展示）"""
        cfg = self.config
        protection_remaining = 0
        if self.state.bed_time:
            protection_remaining = max(
                0,
                int(cfg["fall_asleep_protection"] - (time.time() - self.state.bed_time)),
            )
        return {
            "state": self.state.state,
            "rounds_done": self.state.rounds_done,
            "rounds_remaining": max(0, self._max_rounds() - self.state.rounds_done),
            "current_level": self.state.current_level,
            "cycle_id": self.state.active_cycle_id or None,
            "sequence": self.state.sequence,
            "snore_streak": round(self.state.snore_streak_seconds, 1),
            "protection_remaining_seconds": protection_remaining,
            "verify_snore_stopped": self.state.verify_snore_stopped,
            "verify_body_moved": self.state.verify_body_moved,
            "decisions": self.decision_log[-50:],  # 最近 50 条
        }


# ============================================================
# 七晚学习 Agent（云端专属，本地不做）
# ============================================================

def weekly_adjustment(weekly_events: List[dict], current_config: dict) -> dict:
    """
    七晚学习：根据一周数据自动调整 Agent 参数

    规则（简单可解释，不用LLM）：
    - 成功率 > 80% → 降低起始强度 + 加长冷却（更温和）
    - 成功率 < 50% → 提高起始强度 + 缩短冷却（更果断）
    - 每晚平均 > 5 轮 → 提高上限（更多机会）
    - 每晚平均 < 1 轮 → 降低阈值，更早介入
    """
    if not weekly_events:
        return dict(current_config)

    # 统计
    intervention_events = [e for e in weekly_events if e.get("event_type") == "intervention"]
    total_rounds = len(intervention_events)
    success_rounds = len([e for e in intervention_events if e.get("result") == "success"])
    success_rate = success_rounds / total_rounds if total_rounds > 0 else 0

    nights = len(set(e.get("timestamp", 0) // 86400 for e in intervention_events)) or 1
    avg_rounds = total_rounds / nights

    new_cfg = dict(current_config)

    # 成功率高 → 更温和
    if success_rate > 0.8:
        new_cfg["start_vibration_level"] = max(1, new_cfg.get("start_vibration_level", 2) - 1)
        new_cfg["cooldown_seconds"] = min(1200, new_cfg.get("cooldown_seconds", 600) + 120)
    # 成功率低 → 更果断
    elif success_rate < 0.5 and total_rounds >= 3:
        new_cfg["start_vibration_level"] = min(2, new_cfg.get("start_vibration_level", 1) + 1)
        new_cfg["cooldown_seconds"] = max(300, new_cfg.get("cooldown_seconds", 600) - 120)

    # 轮数多 → 提高上限
    if avg_rounds > 5:
        new_cfg["max_rounds_per_night"] = min(10, new_cfg.get("max_rounds_per_night", 6) + 2)

    return {
        "new_config": new_cfg,
        "stats": {
            "total_rounds": total_rounds,
            "success_rounds": success_rounds,
            "success_rate": round(success_rate, 3),
            "nights": nights,
            "avg_rounds_per_night": round(avg_rounds, 1),
        },
        "changes": {k: v for k, v in new_cfg.items() if v != current_config.get(k)}
    }


def generate_morning_report_prompt(events: List[dict], stats: dict) -> str:
    """生成晨报的 LLM prompt"""
    total = stats.get("total_rounds", 0)
    success = stats.get("success_rounds", 0)
    rate = stats.get("success_rate", 0)
    avg_rt = stats.get("avg_response_time", 0)
    max_lvl = stats.get("max_level", 0)

    return f"""你是好眠SnoozMate的睡眠管家。请用温暖、安心的语气，总结用户昨晚的睡眠情况。
重点：不说吓人的话、不用医学术语、不做诊断。
数据只是记录，不说"你有问题"，只说"我们记录到这些"。

昨夜数据：
- 干预次数：{total} 次
- 干预成功：{success} 次（成功率 {int(rate*100)}%）
- 平均响应时间：{avg_rt:.0f} 秒
- 最高振动等级：L{max_lvl}

输出格式（就两句话）：
第一行：昨夜整体总结（30字以内，不用数字堆砌）
第二行：一个小建议（20字以内，温和具体）
"""
