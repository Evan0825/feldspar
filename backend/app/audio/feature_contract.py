"""Versioned DSP input and observe-only rule baseline. No actuator commands."""
from collections import deque
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class FeatureWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    protocol_version: Literal["feldspar-features-v1"]
    device_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=64)
    sequence: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    monotonic_end_ms: int = Field(ge=0)
    clock_valid: bool
    sample_rate: Literal[16000]
    sample_count: Literal[16000]
    window_ms: Literal[1000]
    context_blocks: int = Field(ge=0, le=300)
    quality_flags: int = Field(ge=0, le=31)
    rms: float = Field(ge=0, le=1)
    clipped_ratio: float = Field(ge=0, le=1)
    band_ratio: float = Field(ge=0, le=1)
    volume_ratio: float = Field(ge=0, le=100)
    periodicity: float = Field(ge=0, le=1)


def rule_score(window: FeatureWindow):
    if window.quality_flags or window.context_blocks != 300 or window.clipped_ratio >= 0.01 or window.rms < 1e-4:
        return None
    spectrum = min(1.0, max(0.0, (window.band_ratio - 0.30) / 0.40))
    volume = min(1.0, max(0.0, (window.volume_ratio - 1.2) / 2.8))
    return min(1.0, 0.35*spectrum + 0.35*window.periodicity + 0.25*volume + 0.05)


class FeatureTracker:
    """One instance per device. Windows must be new and contiguous."""
    def __init__(self):
        self.session = ""
        self.sequence = -1
        self.end_ms = 0
        self.hits = deque(maxlen=30)

    def observe(self, window: FeatureWindow, now_ms: int) -> dict:
        if window.session_id == self.session and window.sequence <= self.sequence:
            return {"status": "duplicate", "automatic_allowed": False}
        broken = window.session_id != self.session or window.sequence != self.sequence+1 or not 900 <= window.monotonic_end_ms-self.end_ms <= 1100
        if broken:
            self.hits.clear()
        self.session, self.sequence, self.end_ms = window.session_id, window.sequence, window.monotonic_end_ms
        score = rule_score(window)
        reason = ""
        if not window.clock_valid or not window.timestamp_ms:
            reason = "clock_unknown"
        elif not -2000 <= now_ms-window.timestamp_ms <= 10000:
            reason = "stale_or_future"
        elif score is None:
            reason = "quality_unknown"
        if reason:
            self.hits.clear()
        else:
            self.hits.append(score >= 0.72)
        rating = "unknown"
        if not reason and len(self.hits) == 30:
            count = sum(self.hits)
            rating = "S0" if count == 0 else "S1" if count < 9 else "S2" if count < 18 else "S3"
        return {"status": "observed", "quality": "unknown" if reason else "good",
                "reason": reason or ("collecting" if len(self.hits)<30 else ""),
                "score": score if not reason else None, "rating": rating,
                "valid_windows": len(self.hits), "rule_version": "feature-rule-v1-unvalidated",
                "automatic_allowed": False}
