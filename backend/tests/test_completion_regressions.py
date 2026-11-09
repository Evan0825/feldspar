"""Offline regressions: memory actuator, temporary SQLite and in-process API only."""
from datetime import datetime
from pathlib import Path
import sqlite3
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from app import database
from app.agent.device_runtime import LocalInterventionRuntime, MemoryActuator, SensorFrame
from app.api import events
from app.config import DEFAULT_AGENT_CONFIG
from app.models.schemas import EventIn
from app.api.device_runtime import RuntimeSnapshotIn
from app.mqtt_service import ExternalAudioModelClient, MqttRealtimeService
from app.agent import ai_interpretation

START = datetime(2026, 10, 19, 22, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()


class StopRegressions(unittest.TestCase):
    def setUp(self):
        self.actuator = MemoryActuator()
        self.runtime = LocalInterventionRuntime(
            "offline-test", self.actuator,
            config={**DEFAULT_AGENT_CONFIG, "fall_asleep_protection": 0,
                    "max_rounds_per_night": 1, "snore_confirm_seconds": 3,
                    "max_vibration_duration_ms": 4000},
        )

    def tick(self, seconds, confidence=0.95):
        return self.runtime.tick(SensorFrame(START + seconds, confidence, True, 0))

    def start_last_round(self):
        for seconds in (0, 1, 2):
            result = self.tick(seconds)
        self.assertEqual(result["action"], "VIBRATE_L1")
        self.assertEqual(self.runtime.agent.state.rounds_done, 1)

    def test_last_allowed_round_runs_to_deadline_then_stops(self):
        self.start_last_round()
        self.assertTrue(self.tick(3)["action"].startswith("VIBRATE_L"))
        self.assertEqual(self.tick(6)["action"], "STOP")
        self.assertEqual(self.actuator.level, 0)
        for seconds in (7, 700, 701, 702, 703):
            self.assertFalse(self.tick(seconds)["action"].startswith("VIBRATE_L"))
            self.assertEqual(self.actuator.level, 0)

    def test_deadline_is_checked_before_low_confidence_early_return(self):
        self.runtime.config["max_rounds_per_night"] = 2
        self.start_last_round()
        self.assertEqual(self.tick(6, confidence=0.1)["action"], "STOP")
        self.assertEqual(self.actuator.level, 0)

    def test_last_allowed_round_can_finish_verification(self):
        self.runtime.config["max_vibration_duration_ms"] = 30000
        self.start_last_round()
        for seconds in (3, 4, 5):
            result = self.tick(seconds, confidence=0.1)
        self.assertEqual(result["action"], "PAUSE")
        self.assertEqual(self.actuator.level, 0)
        self.assertEqual(self.tick(21, confidence=0.1)["action"], "STOP")
        self.assertEqual(self.runtime.agent.state.state, "COOLDOWN")

    def test_zero_budget_never_starts(self):
        self.runtime.config["max_rounds_per_night"] = 0
        for seconds in range(10):
            self.assertFalse(self.tick(seconds)["action"].startswith("VIBRATE_L"))
        self.assertEqual(self.actuator.level, 0)

    def test_non_actuation_result_cannot_leave_reference_output_running(self):
        self.start_last_round()
        with patch.object(self.runtime.agent, "process_tick", return_value={"action": "NONE"}):
            self.tick(3)
        self.assertEqual(self.actuator.level, 0)


class UnknownObservationRegressions(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="feldspar-db-test-")
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(database, "DATABASE_BACKEND", "sqlite").start()
        patch.object(database, "DB_PATH", str(Path(self.directory.name) / "test.db")).start()
        database.init_db()

    def payload(self, timestamp=START, **observations):
        return {"device_id": "offline-test", "timestamp": int(timestamp),
                "event_type": "snore_detected", **observations}

    def latest_observations(self):
        conn = database.get_conn()
        try:
            return dict(conn.execute("SELECT in_bed, body_motion_level FROM events ORDER BY id DESC LIMIT 1").fetchone())
        finally:
            conn.close()

    def test_schema_distinguishes_unknown_from_false_and_zero(self):
        for values in ({}, {"in_bed": None, "body_motion_level": None}):
            event = EventIn(**self.payload(**values))
            self.assertIsNone(event.in_bed)
            self.assertIsNone(event.body_motion_level)
        event = EventIn(**self.payload(in_bed=False, body_motion_level=0))
        self.assertIs(event.in_bed, False)
        self.assertEqual(event.body_motion_level, 0)

    def test_runtime_snapshot_defaults_do_not_invent_sensor_readings(self):
        snapshot = RuntimeSnapshotIn(sequence=1)
        self.assertIsNone(snapshot.in_bed)
        self.assertIsNone(snapshot.body_motion_level)
        self.assertIsNone(snapshot.temperature_ok)
        self.assertIsNone(snapshot.stop_latched)

    def test_cloud_gate_requires_verified_guard_and_an_explicit_clear_stop(self):
        service = MqttRealtimeService(now_fn=lambda: START)
        snapshot = {"received_at": int(START), "in_bed": True, "temperature_ok": True,
                    "mic_status": "ready", "radar_status": "ready", "pad_status": "connected",
                    "state": "MONITORING", "active_level": 0, "night_id": "offline-night"}
        self.assertFalse(service._validate_snapshot_gate("offline-test", snapshot, int(START))["ok"])
        snapshot["capabilities"] = {"actuation_guard": 1, "automatic_enabled": True}
        for stopped in (None, True):
            snapshot["stop_latched"] = stopped
            self.assertFalse(service._validate_snapshot_gate("offline-test", snapshot, int(START))["ok"])
        snapshot["stop_latched"] = False
        self.assertTrue(service._validate_snapshot_gate("offline-test", snapshot, int(START))["ok"])
        snapshot["capabilities"]["automatic_enabled"] = False
        self.assertFalse(service._validate_snapshot_gate("offline-test", snapshot, int(START))["ok"])

    def test_mqtt_observation_requires_ready_radar_for_presence_and_motion(self):
        cases = ({}, {"radar_status": "not_installed", "in_bed": True, "body_motion_level": 0},
                 {"radar_status": "ready", "in_bed": False, "body_motion_level": 0})
        for index, snapshot in enumerate(cases):
            service = MqttRealtimeService(now_fn=lambda: START)
            analysis = SimpleNamespace(confidence=0.95, timestamp_ms=int((START + index) * 1000),
                                       duration_seconds=2, source="offline-test")
            self.assertGreater(service._persist_audio_observation("offline-test", analysis, snapshot), 0)
            expected = {"in_bed": None, "body_motion_level": None} if index < 2 else {"in_bed": 0, "body_motion_level": 0}
            self.assertEqual(self.latest_observations(), expected)

    def test_mqtt_audio_retransmission_preserves_the_window_and_is_not_analyzed_twice(self):
        import base64
        import json
        from app import config
        from app.mqtt_topics import device_topic

        audio_model = Mock()
        audio_model.analyze.return_value = {"confidence": 0.95, "source": "external_audio_model"}
        service = MqttRealtimeService(now_fn=lambda: START, audio_model_client=audio_model)
        topic = device_topic("offline-test", "audio", "up")
        frame_samples = config.MQTT_AUDIO_FRAME_SAMPLES
        frame = {
            "session_id": "synthetic-night", "codec": "pcm_s16le", "channels": 1,
            "timestamp_ms": int(START * 1000), "sample_rate": config.MQTT_AUDIO_SAMPLE_RATE,
            "frame_samples": frame_samples,
            "data_b64": base64.b64encode(bytes(frame_samples * 2)).decode(),
        }

        with patch.multiple(config, MQTT_AUDIO_ENABLED=True, MQTT_AUDIO_ANALYSIS_WINDOW_SECONDS=2.0,
                            AUDIO_MODEL_URL="https://offline-model.invalid"), \
                patch("app.mqtt_service.raw_candidate_audio_allowed", return_value=True):
            def send(sequence):
                return service.ingest_message(topic, json.dumps({**frame, "sequence": sequence}).encode())

            self.assertEqual(send(0)["status"], "buffering")
            self.assertEqual(send(1)["status"], "buffering")
            self.assertEqual(send(1)["status"], "duplicate")
            self.assertEqual(send(2)["status"], "buffering")
            self.assertTrue(send(3)["observation_recorded"])
            for sequence in range(4):
                self.assertEqual(send(sequence)["status"], "duplicate")
            audio_model.analyze.assert_called_once()

    def test_direct_and_batch_database_writes_preserve_unknown(self):
        database.insert_event(self.payload())
        self.assertEqual(self.latest_observations(), {"in_bed": None, "body_motion_level": None})
        database.insert_events_batch([self.payload(START + 1)])
        self.assertEqual(self.latest_observations(), {"in_bed": None, "body_motion_level": None})
        database.init_db()
        self.assertIsNone(self.latest_observations()["in_bed"])

    def test_single_and_batch_api_roundtrip(self):
        app = FastAPI()
        app.include_router(events.router)
        with patch.object(events, "require_device_key"), TestClient(app) as client:
            cases = ({}, {"in_bed": None, "body_motion_level": None},
                     {"in_bed": False, "body_motion_level": 0},
                     {"in_bed": True, "body_motion_level": 0.4})
            for index, observations in enumerate(cases):
                payload = self.payload(START + index, **observations)
                self.assertEqual(client.post("/api/v1/events", json=payload).status_code, 200)
                stored = self.latest_observations()
                self.assertEqual(stored["in_bed"], observations.get("in_bed"))
                self.assertEqual(stored["body_motion_level"], observations.get("body_motion_level"))
            response = client.post("/api/v1/events/batch", json={
                "device_id": "offline-test", "events": [self.payload(START + 10)]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["inserted"], 1)
            self.assertIsNone(self.latest_observations()["in_bed"])

    def test_legacy_sqlite_defaults_do_not_invent_new_observations(self):
        # Old SQLite tables permit NULL but default an omitted in_bed to 1.
        legacy_path = str(Path(self.directory.name) / "legacy.db")
        conn = sqlite3.connect(legacy_path)
        conn.execute("""CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, night_id TEXT,
            timestamp INTEGER, event_type TEXT, in_bed INTEGER DEFAULT 1,
            body_motion_level REAL DEFAULT 0)""")
        conn.execute("INSERT INTO events(device_id,timestamp,event_type) VALUES ('old',1,'old')")
        conn.commit()
        conn.close()
        with patch.object(database, "DB_PATH", legacy_path):
            database.insert_event(self.payload())
            self.assertIsNone(self.latest_observations()["in_bed"])
            conn = database.get_conn()
            try:
                self.assertEqual(conn.execute("SELECT in_bed FROM events WHERE device_id='old'").fetchone()[0], 1)
            finally:
                conn.close()

    def test_mysql_nullable_migration_is_conditional(self):
        conn = Mock()
        metadata = conn.execute.return_value.fetchall
        metadata.return_value = [{"name": "in_bed", "nullable": "NO", "default_value": "1"},
                                 {"name": "body_motion_level", "nullable": "NO", "default_value": "0"}]
        database._allow_unknown_mysql_observations(conn)
        changes = [call.args[0] for call in conn.execute.call_args_list if call.args[0].startswith("ALTER TABLE")]
        self.assertEqual(len(changes), 1)
        self.assertIn("in_bed TINYINT NULL DEFAULT NULL", changes[0])
        self.assertIn("body_motion_level DOUBLE NULL DEFAULT NULL", changes[0])
        conn.reset_mock()
        metadata.return_value = [{"name": "in_bed", "nullable": "YES", "default_value": None},
                                 {"name": "body_motion_level", "nullable": "YES", "default_value": None}]
        database._allow_unknown_mysql_observations(conn)
        self.assertFalse(any(call.args[0].startswith("ALTER TABLE") for call in conn.execute.call_args_list))


class DeepSeekProviderChecks(unittest.IsolatedAsyncioTestCase):
    def test_explicit_provider_does_not_inherit_another_providers_credentials(self):
        env = {**os.environ, "SNOOZMATE_LLM_PROVIDER": "deepseek", "SNOOZMATE_LLM_KEY": "",
               "SNOOZMATE_LLM_BASE_URL": "", "SNOOZMATE_LLM_MODEL": "", "DEEPSEEK_API_KEY": "",
               "OPENAI_API_KEY": "unrelated-fixture", "OPENAI_BASE_URL": "https://other.example.invalid",
               "OPENAI_MODEL": "unrelated-model"}
        subprocess.run([sys.executable, "-c", """
from app import config
assert config.LLM_API_KEY == ""
assert config.LLM_BASE_URL == "https://api.deepseek.com"
assert config.LLM_MODEL == "deepseek-flash"
"""], cwd=Path(__file__).resolve().parents[1], env=env, check=True)

    async def test_deepseek_request_uses_nonthinking_mode(self):
        import json

        calls = []
        def reply(request):
            calls.append((str(request.url), json.loads(request.content)))
            return httpx.Response(200, json={"choices": [{"message": {"content": "结构化测试通过"}}]})

        client = httpx.AsyncClient
        with patch.multiple(ai_interpretation.config, LLM_PROVIDER="deepseek", LLM_API_KEY="fixture",
                            LLM_BASE_URL="https://api.deepseek.com", LLM_MODEL="deepseek-flash"), \
                patch.object(ai_interpretation.httpx, "AsyncClient", side_effect=lambda **kw:
                    client(transport=httpx.MockTransport(reply), **kw)):
            result = await ai_interpretation.request_llm_chat([{"role": "user", "content": "合成测试"}], 80)
        self.assertEqual(result, "结构化测试通过")
        self.assertEqual(calls[0][0], "https://api.deepseek.com/chat/completions")
        self.assertEqual(calls[0][1]["thinking"], {"type": "disabled"})


class ArkStandardProviderChecks(unittest.IsolatedAsyncioTestCase):
    def test_dual_profile_uses_the_standard_ark_endpoint_and_dedicated_key(self):
        env = {**os.environ, "SNOOZMATE_LLM_PROVIDER": "volcengine-ark-standard",
               "ARK_API_KEY": "ark-fixture", "OPENAI_API_KEY": "unrelated-fixture",
               "SNOOZMATE_LLM_KEY": "old-fixture", "SNOOZMATE_LLM_MODEL": "",
               "SNOOZMATE_AUDIO_MODEL_KEY": "", "SNOOZMATE_AUDIO_MODEL_NAME": "",
               "SNOOZMATE_MQTT_AUDIO_ENABLED": "false", "SNOOZMATE_RAW_CANDIDATE_AUDIO_ENABLED": "false"}
        subprocess.run([sys.executable, "-c", """
from app import config
assert config.LLM_BASE_URL == config.AUDIO_MODEL_URL == "https://ark.cn-beijing.volces.com/api/v3"
assert config.LLM_API_KEY == config.AUDIO_MODEL_KEY == "ark-fixture"
assert config.LLM_MODEL == "deepseek-v4-1-flash-261017"
assert config.AUDIO_MODEL_NAME == "doubao-seed-2-1-lite-260915"
assert config.AUDIO_MODEL_PROTOCOL == "volcengine_chat"
assert config.AUDIO_MODEL_AUDIO_PART_TYPE == "input_audio"
assert not config.MQTT_AUDIO_ENABLED and not config.RAW_CANDIDATE_AUDIO_ENABLED
"""], cwd=Path(__file__).resolve().parents[1], env=env, check=True)

    async def test_text_uses_standard_inference_with_nonthinking_mode(self):
        import json

        captured = []
        def reply(request):
            captured.append((str(request.url), json.loads(request.content)))
            return httpx.Response(200, json={"model": "deepseek-v4-1-flash-261017", "choices": [
                {"message": {"content": "结构化样本"}}]})

        client = httpx.AsyncClient
        with patch.multiple(ai_interpretation.config, LLM_PROVIDER="volcengine-ark-standard",
                            LLM_API_KEY="ark-fixture", LLM_BASE_URL="https://ark.cn-beijing.volces.com/api/v3",
                            LLM_MODEL="deepseek-v4-1-flash-261017"), \
                patch.object(ai_interpretation.httpx, "AsyncClient", side_effect=lambda **kw:
                    client(transport=httpx.MockTransport(reply), **kw)):
            result = await ai_interpretation.request_llm_chat([{"role": "user", "content": "合成晨报"}], 80)
        self.assertEqual(result, "结构化样本")
        self.assertEqual(captured[0][0], "https://ark.cn-beijing.volces.com/api/v3/chat/completions")
        self.assertEqual(captured[0][1]["model"], "deepseek-v4-1-flash-261017")
        self.assertEqual(captured[0][1]["thinking"], {"type": "disabled"})

    def test_synthetic_audio_uses_the_ark_wav_format_without_device_identifiers(self):
        import base64
        import io
        import json
        import wave
        from app import config

        response = Mock()
        response.json.return_value = {"model": "doubao-seed-2-1-lite-260915", "choices": [
            {"message": {"content": '{"confidence": 0.1, "is_snore": false, "reason": "synthetic"}'}}]}
        pcm = b"\x00\x00" * 1600
        with patch.multiple(config, LLM_PROVIDER="volcengine-ark-standard",
                            AUDIO_MODEL_PROTOCOL="volcengine_chat", AUDIO_MODEL_AUDIO_PART_TYPE="input_audio",
                            AUDIO_MODEL_URL="https://ark.cn-beijing.volces.com/api/v3",
                            AUDIO_MODEL_KEY="ark-fixture", AUDIO_MODEL_NAME="doubao-seed-2-1-lite-260915"), \
                patch("app.mqtt_service.requests.post", return_value=response) as post:
            result = ExternalAudioModelClient().analyze(device_id="offline-device", session_id="synthetic",
                sequence_start=1, sequence_end=1, timestamp_ms=0, sample_rate=16000, pcm_bytes=pcm)
        self.assertEqual(result["confidence"], 0.1)
        self.assertEqual(post.call_args.args[0], "https://ark.cn-beijing.volces.com/api/v3/chat/completions")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertNotIn("offline-device", json.dumps(body))
        audio = body["messages"][1]["content"][1]["input_audio"]
        self.assertEqual(audio["format"], "wav")
        with wave.open(io.BytesIO(base64.b64decode(audio["data"], validate=True))) as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (16000, 1, 2))
            self.assertEqual(wav.readframes(wav.getnframes()), pcm)


if __name__ == "__main__":
    unittest.main()
