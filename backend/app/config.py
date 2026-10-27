"""Runtime configuration. Secrets are supplied only through environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _truthy(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _clamp_int(value: str | int, default: int, minimum: int, maximum: int) -> int:
    parsed = int(value if value not in (None, "") else default)
    return max(minimum, min(parsed, maximum))


def _clamp_float(value: str | float, default: float, minimum: float, maximum: float) -> float:
    parsed = float(value if value not in (None, "") else default)
    return max(minimum, min(parsed, maximum))


def _db_path() -> str:
    configured = os.environ.get("SNOOZMATE_DB_PATH")
    path = Path(configured).expanduser() if configured else BASE_DIR / "data" / "snoozmate.db"
    return str(path.resolve())


# Use an absolute path so the database never silently follows a process cwd.
DB_PATH = _db_path()
DB_BUSY_TIMEOUT_MS = int(os.environ.get("SNOOZMATE_DB_BUSY_TIMEOUT_MS", "5000"))
SEED_DEMO_DATA = _truthy("SNOOZMATE_SEED_DEMO_DATA")
# Experience data is created only after an authenticated user explicitly
# confirms it and is refused when real device events already exist.
ALLOW_SIMULATED_EXPERIENCE_DATA = _truthy(
    "SNOOZMATE_ALLOW_SIMULATED_EXPERIENCE_DATA",
    True,
)
DEFAULT_DEVICE_ID = os.environ.get("SNOOZMATE_DEFAULT_DEVICE_ID", "device_esp32_real_001").strip()
DEVICE_ONLINE_TTL_SECONDS = int(os.environ.get("SNOOZMATE_DEVICE_ONLINE_TTL_SECONDS", "300"))
DEVICE_RUNTIME_TTL_SECONDS = int(os.environ.get("SNOOZMATE_DEVICE_RUNTIME_TTL_SECONDS", "15"))
REQUIRE_DEVICE_AUTH = _truthy("SNOOZMATE_REQUIRE_DEVICE_AUTH", True)
DEVICE_KEY_PEPPER = os.environ.get("SNOOZMATE_DEVICE_KEY_PEPPER", "")
ENABLE_CLOUD_AGENT_DEBUG = _truthy("SNOOZMATE_ENABLE_CLOUD_AGENT_DEBUG", False)
REQUIRE_USER_DEVICE_AUTH = _truthy("SNOOZMATE_REQUIRE_USER_DEVICE_AUTH", True)
# SnoozMate demo devices are shared household equipment: users authenticate to
# the service, but do not need an exclusive device-binding record to use it.
DEVICE_ACCESS_MODE = os.environ.get("SNOOZMATE_DEVICE_ACCESS_MODE", "shared").strip().lower() or "shared"
if DEVICE_ACCESS_MODE not in {"shared", "bound"}:
    raise ValueError("SNOOZMATE_DEVICE_ACCESS_MODE must be shared or bound")
# Optional maintenance pairing compatibility for deployments that still use
# the legacy owner/member records.
ALLOW_BLE_LOCAL_BINDING = _truthy("SNOOZMATE_ALLOW_BLE_LOCAL_BINDING", True)

# SQLite is the local-development default. CloudBase Run should provide all
# DB_* values so the service uses its managed MySQL instead of container files.
DB_HOST = os.environ.get("DB_HOST", "").strip()
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "").strip()
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "").strip()
DB_CHARSET = os.environ.get("DB_CHARSET", "utf8mb4").strip() or "utf8mb4"
DB_CONNECT_TIMEOUT_SECONDS = float(os.environ.get("DB_CONNECT_TIMEOUT_SECONDS", "4"))
DB_READ_TIMEOUT_SECONDS = float(os.environ.get("DB_READ_TIMEOUT_SECONDS", "8"))
DB_WRITE_TIMEOUT_SECONDS = float(os.environ.get("DB_WRITE_TIMEOUT_SECONDS", "8"))
DB_POOL_SIZE = max(1, int(os.environ.get("DB_POOL_SIZE", "6")))
_requested_backend = os.environ.get("SNOOZMATE_DB_BACKEND", "").strip().lower()
if _requested_backend:
    DATABASE_BACKEND = _requested_backend
elif all((DB_HOST, DB_USER, DB_NAME)):
    DATABASE_BACKEND = "mysql"
else:
    DATABASE_BACKEND = "sqlite"
if DATABASE_BACKEND not in {"sqlite", "mysql"}:
    raise ValueError("SNOOZMATE_DB_BACKEND must be sqlite or mysql")

# A night is the evening window through the following late morning. Keeping
# the timezone and boundaries explicit prevents daytime diagnostics from being
# mistaken for the latest sleep record when a container uses UTC.
NIGHT_TIMEZONE = os.environ.get("SNOOZMATE_NIGHT_TIMEZONE", "Asia/Shanghai").strip() or "Asia/Shanghai"
NIGHT_START_HOUR = int(os.environ.get("SNOOZMATE_NIGHT_START_HOUR", "18"))
NIGHT_END_HOUR = int(os.environ.get("SNOOZMATE_NIGHT_END_HOUR", "12"))
if not 0 <= NIGHT_START_HOUR <= 23 or not 0 <= NIGHT_END_HOUR <= 23 or NIGHT_START_HOUR <= NIGHT_END_HOUR:
    raise ValueError("SNOOZMATE_NIGHT_START_HOUR must be after NIGHT_END_HOUR within the same 24-hour cycle")

# LLM is optional. Credentials are read from deployment environment variables only.
_OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
_ARK_KEY = os.environ.get("ARK_API_KEY", "").strip()
LLM_API_KEY = os.environ.get("SNOOZMATE_LLM_KEY", "").strip() or _OPENAI_KEY or _ARK_KEY
_provider = os.environ.get("SNOOZMATE_LLM_PROVIDER", "").strip()
LLM_PROVIDER = _provider or ("volcengine-ark" if _ARK_KEY and not _OPENAI_KEY else "openai")
LLM_BASE_URL = os.environ.get("SNOOZMATE_LLM_BASE_URL", "").strip() or os.environ.get(
    "OPENAI_BASE_URL",
    "https://ark.cn-beijing.volces.com/api/coding/v3" if LLM_PROVIDER == "volcengine-ark" else "https://api.openai.com/v1",
).strip()
CODING_PLAN_DEFAULT_MODEL = (
    os.environ.get("SNOOZMATE_CODING_PLAN_MODEL", "").strip()
    or "ark-code-latest"
)
CODING_PLAN_FALLBACK_MODELS = tuple(
    model.strip()
    for model in os.environ.get(
        "SNOOZMATE_CODING_PLAN_FALLBACK_MODELS",
        "ark-code-latest,deepseek-v4-flash",
    ).split(",")
    if model.strip()
)
LLM_MODEL = (
    os.environ.get("SNOOZMATE_LLM_MODEL", "").strip()
    or os.environ.get("OPENAI_MODEL", "").strip()
    or os.environ.get("ARK_MODEL", "").strip()
    or os.environ.get("ARK_ENDPOINT_ID", "").strip()
    or (CODING_PLAN_DEFAULT_MODEL if LLM_PROVIDER == "volcengine-ark" else "gpt-4o-mini")
)
_ark_llm = LLM_PROVIDER == "volcengine-ark" or "/api/coding/" in LLM_BASE_URL
if _ark_llm and LLM_BASE_URL.endswith("/api/coding/v1"):
    LLM_BASE_URL = LLM_BASE_URL[:-2] + "v3"
LLM_CONNECT_TIMEOUT_SECONDS = float(os.environ.get(
    "SNOOZMATE_LLM_CONNECT_TIMEOUT_SECONDS",
    "2" if _ark_llm else "1.5",
))
LLM_READ_TIMEOUT_SECONDS = float(os.environ.get(
    "SNOOZMATE_LLM_READ_TIMEOUT_SECONDS",
    "20" if _ark_llm else "3",
))
LLM_OVERALL_TIMEOUT_SECONDS = float(os.environ.get(
    "SNOOZMATE_LLM_OVERALL_TIMEOUT_SECONDS",
    "30" if _ark_llm else "4",
))

# Configure these in production to exchange wx.login codes for a stable openid.
# During local/cloud debugging, the mini program sends a persistent installation ID
# so changing one-time login codes do not create a new user on every launch.
WECHAT_APP_ID = os.environ.get("SNOOZMATE_WECHAT_APP_ID", "").strip()
WECHAT_APP_SECRET = os.environ.get("SNOOZMATE_WECHAT_APP_SECRET", "").strip()
AUTH_MODE = os.environ.get("SNOOZMATE_AUTH_MODE", "auto").strip().lower()
if AUTH_MODE not in {"auto", "debug", "production"}:
    raise ValueError("SNOOZMATE_AUTH_MODE must be auto, debug or production")
WECHAT_LOGIN_TIMEOUT_SECONDS = float(os.environ.get("SNOOZMATE_WECHAT_LOGIN_TIMEOUT_SECONDS", "3"))
WECHAT_CODE2SESSION_URL = os.environ.get(
    "SNOOZMATE_WECHAT_CODE2SESSION_URL",
    "https://api.weixin.qq.com/sns/jscode2session",
).strip() or "https://api.weixin.qq.com/sns/jscode2session"
# wx.cloud.callContainer injects a signed WeChat identity into requests that
# arrive through the CloudBase gateway. It avoids a separate public egress
# request to code2session for Mini Program users.
CLOUDBASE_HEADER_AUTH_ENABLED = _truthy(
    "SNOOZMATE_CLOUDBASE_HEADER_AUTH_ENABLED",
    True,
)
SESSION_TTL_SECONDS = int(os.environ.get("SNOOZMATE_SESSION_TTL_SECONDS", str(30 * 24 * 60 * 60)))

# Agent 默认参数（可被七晚学习覆盖）
DEFAULT_AGENT_CONFIG = {
    "max_rounds_per_night": 6,
    "cooldown_seconds": 600,
    "fall_asleep_protection": 900,
    "max_vibration_duration_ms": 120000,
    "start_vibration_level": 1,
    "max_vibration_level": 3,
    "upgrade_interval_ms": 8000,
    "snore_confirm_seconds": 10,
    "snore_stop_confirm_seconds": 3,
    "snore_confidence_threshold": 0.65,
    "body_motion_success_threshold": 0.65,
    "verify_window_seconds": 15,
    "partner_mode_max_rounds": 4,
}

AUDIO_CONFIG = {
    "sample_rate": 16000,
    "n_mfcc": 13,
    "n_fft": 512,
    "hop_length": 256,
    "frame_seconds": 1.0,
}

# MQTT realtime audio/control path. Disabled by default until a broker is
# intentionally configured; the HTTP polling/ACK path remains the compatibility
# fallback for any command the device does not receive over MQTT.
MQTT_ENABLED = _truthy("SNOOZMATE_MQTT_ENABLED", False)
MQTT_BROKER_HOST = os.environ.get("SNOOZMATE_MQTT_BROKER_HOST", "").strip()
MQTT_BROKER_PORT = _clamp_int(os.environ.get("SNOOZMATE_MQTT_BROKER_PORT", "8883"), 8883, 1, 65535)
MQTT_USERNAME = os.environ.get("SNOOZMATE_MQTT_USERNAME", "").strip()
MQTT_PASSWORD = os.environ.get("SNOOZMATE_MQTT_PASSWORD", "")
MQTT_CLIENT_ID = os.environ.get("SNOOZMATE_MQTT_CLIENT_ID", "snoozmate-cloud-backend").strip() or "snoozmate-cloud-backend"
MQTT_CLIENT_ID_PER_INSTANCE = _truthy("SNOOZMATE_MQTT_CLIENT_ID_PER_INSTANCE", True)
MQTT_KEEPALIVE_SECONDS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_KEEPALIVE_SECONDS", "60"), 60, 15, 3600)
MQTT_TLS_ENABLED = _truthy("SNOOZMATE_MQTT_TLS_ENABLED", True)
MQTT_TLS_CA_CERT = os.environ.get("SNOOZMATE_MQTT_TLS_CA_CERT", "").strip()
MQTT_TLS_INSECURE = _truthy("SNOOZMATE_MQTT_TLS_INSECURE", False)
MQTT_TOPIC_PREFIX = os.environ.get("SNOOZMATE_MQTT_TOPIC_PREFIX", "snoozmate/v1").strip().strip("/") or "snoozmate/v1"
MQTT_QOS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_QOS", "1"), 1, 0, 2)
MQTT_WORKER_QUEUE_SIZE = _clamp_int(os.environ.get("SNOOZMATE_MQTT_WORKER_QUEUE_SIZE", "64"), 64, 4, 1024)
MQTT_HTTP_AUTH_ENABLED = _truthy("SNOOZMATE_MQTT_HTTP_AUTH_ENABLED", False)
MQTT_HTTP_AUTH_SHARED_SECRET = os.environ.get("SNOOZMATE_MQTT_HTTP_AUTH_SHARED_SECRET", "")
MQTT_SERVICE_USERNAME = os.environ.get("SNOOZMATE_MQTT_SERVICE_USERNAME", "").strip() or MQTT_USERNAME
MQTT_SERVICE_PASSWORD = os.environ.get("SNOOZMATE_MQTT_SERVICE_PASSWORD", "") or MQTT_PASSWORD
if MQTT_ENABLED and (not MQTT_TLS_ENABLED or MQTT_TLS_INSECURE):
    raise ValueError("MQTT realtime service requires verified TLS")
if MQTT_ENABLED and not (MQTT_USERNAME and MQTT_PASSWORD):
    raise ValueError("MQTT backend service username and password are required")
if MQTT_HTTP_AUTH_ENABLED and not MQTT_HTTP_AUTH_SHARED_SECRET:
    raise ValueError("SNOOZMATE_MQTT_HTTP_AUTH_SHARED_SECRET is required when MQTT HTTP auth is enabled")

MQTT_AUDIO_ENABLED = _truthy("SNOOZMATE_MQTT_AUDIO_ENABLED", False)
MQTT_AUDIO_SAMPLE_RATE = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_SAMPLE_RATE", "8000"), 8000, 8000, 8000)
MQTT_AUDIO_CHUNK_MS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_CHUNK_MS", "500"), 500, 500, 500)
MQTT_AUDIO_FRAME_SAMPLES = int(MQTT_AUDIO_SAMPLE_RATE * MQTT_AUDIO_CHUNK_MS / 1000)
MQTT_AUDIO_MAX_PAYLOAD_BYTES = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_PAYLOAD_BYTES", "65536"), 65536, 4096, 512000)
MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS = _clamp_float(
    os.environ.get("SNOOZMATE_MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS", "2.0"),
    2.0,
    2.0,
    3.0,
)
MQTT_AUDIO_MAX_WINDOW_SECONDS = _clamp_float(
    os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_WINDOW_SECONDS", "3.0"),
    3.0,
    2.0,
    3.0,
)
if MQTT_AUDIO_MAX_WINDOW_SECONDS < MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS:
    raise ValueError("SNOOZMATE_MQTT_AUDIO_MAX_WINDOW_SECONDS must be >= SNOOZMATE_MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS")
MQTT_AUDIO_MAX_CAPTURE_SECONDS = _clamp_float(
    os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_CAPTURE_SECONDS", str(MQTT_AUDIO_MAX_WINDOW_SECONDS)),
    MQTT_AUDIO_MAX_WINDOW_SECONDS,
    MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS,
    3.0,
)
MQTT_AUDIO_STALE_SECONDS = _clamp_float(os.environ.get("SNOOZMATE_MQTT_AUDIO_STALE_SECONDS", "10"), 10.0, 1.0, 120.0)
MQTT_AUDIO_MAX_FUTURE_MS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_FUTURE_MS", "2000"), 2000, 0, 60000)
MQTT_AUDIO_SNORE_THRESHOLD = _clamp_float(os.environ.get("SNOOZMATE_MQTT_AUDIO_SNORE_THRESHOLD", "0.72"), 0.72, 0.1, 1.0)
MQTT_AUDIO_CONFIRM_WINDOWS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_CONFIRM_WINDOWS", "2"), 2, 1, 5)
MQTT_AUDIO_COOLDOWN_SECONDS = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_COOLDOWN_SECONDS", "600"), 600, 30, 3600)
MQTT_AUDIO_OBSERVATION_COOLDOWN_SECONDS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_AUDIO_OBSERVATION_COOLDOWN_SECONDS", "60"),
    60,
    10,
    3600,
)
MQTT_AUDIO_MAX_COMMANDS_PER_HOUR = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_COMMANDS_PER_HOUR", "3"), 3, 1, 20)
MQTT_AUDIO_MAX_COMMANDS_PER_NIGHT = _clamp_int(os.environ.get("SNOOZMATE_MQTT_AUDIO_MAX_COMMANDS_PER_NIGHT", "6"), 6, 1, 30)
MQTT_AUDIO_SNAPSHOT_TTL_SECONDS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_AUDIO_SNAPSHOT_TTL_SECONDS", str(DEVICE_RUNTIME_TTL_SECONDS)),
    DEVICE_RUNTIME_TTL_SECONDS,
    1,
    120,
)
MQTT_INTERVENTION_COMMAND_TTL_SECONDS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_COMMAND_TTL_SECONDS", "45"),
    45,
    10,
    600,
)
MQTT_INTERVENTION_VIBRATION_LEVEL = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_VIBRATION_LEVEL", "1"),
    1,
    1,
    3,
)
MQTT_INTERVENTION_VIBRATION_DURATION_MS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_VIBRATION_DURATION_MS", "8000"),
    8000,
    1000,
    10000,
)
MQTT_INTERVENTION_SOUND_ENABLED = _truthy("SNOOZMATE_MQTT_INTERVENTION_SOUND_ENABLED", False)
MQTT_INTERVENTION_SOUND_SCENE = os.environ.get("SNOOZMATE_MQTT_INTERVENTION_SOUND_SCENE", "sleep").strip() or "sleep"
if MQTT_INTERVENTION_SOUND_SCENE not in {"sleep", "healing", "work", "reading"}:
    raise ValueError("SNOOZMATE_MQTT_INTERVENTION_SOUND_SCENE must be sleep/healing/work/reading")
MQTT_INTERVENTION_SOUND_VOLUME = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_SOUND_VOLUME", "20"),
    20,
    0,
    100,
)
MQTT_INTERVENTION_SOUND_DURATION_MS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_SOUND_DURATION_MS", "8000"),
    8000,
    1000,
    10000,
)
MQTT_INTERVENTION_LIGHT_ENABLED = _truthy("SNOOZMATE_MQTT_INTERVENTION_LIGHT_ENABLED", False)
MQTT_INTERVENTION_LIGHT_MODE = os.environ.get("SNOOZMATE_MQTT_INTERVENTION_LIGHT_MODE", "night-low").strip() or "night-low"
MQTT_INTERVENTION_LIGHT_COLOR = os.environ.get("SNOOZMATE_MQTT_INTERVENTION_LIGHT_COLOR", "amber").strip().lower() or "amber"
if MQTT_INTERVENTION_LIGHT_COLOR not in {"amber", "warm-amber", "warm-yellow"}:
    raise ValueError("SNOOZMATE_MQTT_INTERVENTION_LIGHT_COLOR must be amber/warm-amber/warm-yellow")
MQTT_INTERVENTION_LIGHT_BRIGHTNESS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_LIGHT_BRIGHTNESS", "10"),
    10,
    5,
    40,
)
MQTT_INTERVENTION_LIGHT_DURATION_MS = _clamp_int(
    os.environ.get("SNOOZMATE_MQTT_INTERVENTION_LIGHT_DURATION_MS", "8000"),
    8000,
    1000,
    10000,
)

AUDIO_MODEL_URL = os.environ.get("SNOOZMATE_AUDIO_MODEL_URL", "").strip()
AUDIO_MODEL_PROTOCOL = os.environ.get("SNOOZMATE_AUDIO_MODEL_PROTOCOL", "custom_json").strip().lower()
if AUDIO_MODEL_PROTOCOL not in {"custom_json", "volcengine_chat"}:
    raise ValueError("SNOOZMATE_AUDIO_MODEL_PROTOCOL must be custom_json or volcengine_chat")
AUDIO_MODEL_AUDIO_PART_TYPE = os.environ.get(
    "SNOOZMATE_AUDIO_MODEL_AUDIO_PART_TYPE",
    "input_audio",
).strip().lower()
if AUDIO_MODEL_AUDIO_PART_TYPE not in {"input_audio", "audio", "audio_url"}:
    raise ValueError("SNOOZMATE_AUDIO_MODEL_AUDIO_PART_TYPE must be input_audio/audio/audio_url")
AUDIO_MODEL_KEY = os.environ.get("SNOOZMATE_AUDIO_MODEL_KEY", "").strip() or LLM_API_KEY
AUDIO_MODEL_NAME = (
    os.environ.get("SNOOZMATE_AUDIO_MODEL_NAME", "").strip()
    or ("auto" if AUDIO_MODEL_PROTOCOL == "volcengine_chat" else "")
)
AUDIO_MODEL_TIMEOUT_SECONDS = _clamp_float(
    os.environ.get("SNOOZMATE_AUDIO_MODEL_TIMEOUT_SECONDS", "3"),
    3.0,
    0.5,
    30.0,
)
RAW_CANDIDATE_AUDIO_ENABLED = _truthy("SNOOZMATE_RAW_CANDIDATE_AUDIO_ENABLED", False)
RAW_CANDIDATE_AUDIO_CONSENT_VERSION = (
    os.environ.get("SNOOZMATE_RAW_CANDIDATE_AUDIO_CONSENT_VERSION", "raw-audio-v1").strip()
    or "raw-audio-v1"
)
