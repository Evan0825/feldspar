"""Offline regressions: memory actuator, temporary SQLite and in-process API only."""
from datetime import datetime
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import database
from app.agent.device_runtime import LocalInterventionRuntime, MemoryActuator, SensorFrame
from app.api import events
from app.config import DEFAULT_AGENT_CONFIG
from app.models.schemas import EventIn
from app.api.device_runtime import RuntimeSnapshotIn
from app.mqtt_service import MqttRealtimeService

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


if __name__ == "__main__":
    unittest.main()
