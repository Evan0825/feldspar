"""Single source of truth for bounded local-intervention parameters."""
from __future__ import annotations


AGENT_CONFIG_LIMITS = {
    "max_rounds_per_night": (0, 15),
    "cooldown_seconds": (60, 1800),
    "fall_asleep_protection": (0, 5400),
    "max_vibration_duration_ms": (1000, 300000),
    "start_vibration_level": (1, 3),
    "max_vibration_level": (1, 5),
    "upgrade_interval_ms": (1000, 60000),
    "snore_confirm_seconds": (3, 30),
    "snore_stop_confirm_seconds": (1, 10),
    "snore_confidence_threshold": (0.4, 0.9),
    "body_motion_success_threshold": (0.2, 1),
    "verify_window_seconds": (3, 60),
    "partner_mode_max_rounds": (0, 10),
}

AGENT_CONFIG_EXTENSIONS = {"_sound_state", "_light_state"}


def validate_agent_config(config: dict, *, allow_partial: bool = False) -> dict:
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    allowed = set(AGENT_CONFIG_LIMITS) | AGENT_CONFIG_EXTENSIONS
    unknown = set(config) - allowed
    if unknown:
        raise ValueError(f"unsupported config keys: {','.join(sorted(unknown))}")
    if not allow_partial:
        missing = set(AGENT_CONFIG_LIMITS) - set(config)
        if missing:
            raise ValueError(f"missing config keys: {','.join(sorted(missing))}")
    for key, value in config.items():
        if key in AGENT_CONFIG_EXTENSIONS:
            if not isinstance(value, dict):
                raise ValueError(f"{key} must be an object")
            continue
        low, high = AGENT_CONFIG_LIMITS[key]
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not low <= value <= high
        ):
            raise ValueError(f"{key} must be within [{low}, {high}]")
    start = config.get("start_vibration_level")
    maximum = config.get("max_vibration_level")
    if start is not None and maximum is not None and start > maximum:
        raise ValueError("start_vibration_level cannot exceed max_vibration_level")
    return dict(config)
