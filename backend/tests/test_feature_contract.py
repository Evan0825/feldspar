import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from pydantic import ValidationError
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.audio.feature_contract import FeatureTracker, FeatureWindow
from app import database
from app.api import events
from app.api import device_runtime
from app.mqtt_service import MqttRealtimeService
from app.mqtt_topics import device_topic, allowed_device_publish_topics
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]


def packet(sequence, **changes):
    return {"protocol_version": "feldspar-features-v1", "device_id": "test", "session_id": "boot-a",
            "sequence": sequence, "timestamp_ms": 1000000+sequence*1000, "monotonic_end_ms": sequence*1000,
            "clock_valid": True, "sample_rate": 16000, "sample_count": 16000, "window_ms": 1000,
            "context_blocks": 300, "quality_flags": 0, "rms": 0.1, "clipped_ratio": 0.0,
            "band_ratio": 0.9, "volume_ratio": 4.0, "periodicity": 0.9, **changes}


class FeatureContractTests(unittest.TestCase):
    def test_continuity_quality_duplicate_and_session_boundaries(self):
        tracker = FeatureTracker()
        for sequence in range(1, 31):
            result = tracker.observe(FeatureWindow(**packet(sequence)), 1000000+sequence*1000)
        self.assertEqual(result["rating"], "S3")
        self.assertFalse(result["automatic_allowed"])
        self.assertEqual(tracker.observe(FeatureWindow(**packet(30)), 1030000)["status"], "duplicate")
        self.assertEqual(len(tracker.hits), 30)
        result = tracker.observe(FeatureWindow(**packet(32)), 1032000)
        self.assertEqual(result["valid_windows"], 1)
        result = tracker.observe(FeatureWindow(**packet(33, quality_flags=2)), 1033000)
        self.assertEqual(result["rating"], "unknown")
        self.assertEqual(result["valid_windows"], 0)
        result = tracker.observe(FeatureWindow(**packet(1, session_id="boot-b")), 1001000)
        self.assertEqual(result["valid_windows"], 1)

    def test_bad_or_clockless_input_never_becomes_normal(self):
        for change in ({"clock_valid": False}, {"clipped_ratio": .1}, {"context_blocks": 250}, {"rms": 0.0}):
            result = FeatureTracker().observe(FeatureWindow(**packet(1, **change)), 1001000)
            self.assertEqual(result["quality"], "unknown")
            self.assertIsNone(result["score"])
        for change in ({"rms": float("nan")}, {"sample_count": 100}, {"data_b64": "not-allowed"}, {"band_ratio": 1.1}):
            with self.assertRaises(ValidationError):
                FeatureWindow(**packet(1, **change))

    def test_c_frontend_matches_numpy_reference(self):
        feature_dir = ROOT/"firmware/components/acoustic_features"
        with tempfile.TemporaryDirectory() as folder:
            executable = str(Path(folder)/"features")
            subprocess.run(["clang", "-std=c11", "-O2", "-I", str(feature_dir/"include"), "-I", str(feature_dir),
                str(ROOT/"tests/acoustic_features_test.c"), str(feature_dir/"acoustic_features.c"),
                str(feature_dir/"af_fft512.c"), "-lm", "-o", executable], check=True)
            t = np.arange(16000*8)/16000
            audio = (7000*(.55+.45*np.sin(2*np.pi*.8*t))*np.sin(2*np.pi*250*t)).astype("<i2")
            path = Path(folder)/"fixture.pcm"
            path.write_bytes(audio.tobytes())
            rows = subprocess.check_output([executable, str(path)], text=True).splitlines()
            envelope = []
            for index, row in enumerate(rows):
                flags, blocks, rms, band, volume, periodicity = map(float, row.split(","))
                x = audio[index*16000:(index+1)*16000].astype(np.float64)/32768
                x -= x.mean()
                expected_rms = np.sqrt(np.mean(x*x))
                frames = np.stack([x[start:start+512]*np.hanning(512) for start in range(0, 16000-511, 256)])
                spectrum = np.abs(np.fft.rfft(frames))**2
                frequencies = np.fft.rfftfreq(512, 1/16000)
                expected_band = spectrum[:,(frequencies>=100)&(frequencies<=850)].sum()/spectrum[:,1:].sum()
                envelope.extend(np.sqrt(np.mean(x.reshape(50,320)**2,axis=1)))
                envelope = envelope[-300:]
                expected_volume = expected_rms/max(np.percentile(envelope,20),1e-5)
                self.assertAlmostEqual(rms, expected_rms, places=6)
                self.assertAlmostEqual(band, expected_band, places=5)
                self.assertAlmostEqual(volume, expected_volume, places=5)
                self.assertEqual(int(blocks), len(envelope))
                if index<5:
                    self.assertEqual(int(flags), 16)
                else:
                    env = np.asarray(envelope)-np.mean(envelope)
                    corr = np.correlate(env,env,"full")[len(env)-1:]
                    expected_period = max(0,min(1,corr[20:101].max()/max(corr[0],1e-12)))
                    self.assertEqual(int(flags), 0)
                    self.assertAlmostEqual(periodicity, expected_period, places=5)


class FeatureIngressTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="feature-db-")
        self.addCleanup(self.folder.cleanup)
        self.enterContext(patch.object(database, "DATABASE_BACKEND", "sqlite"))
        self.enterContext(patch.object(database, "DB_PATH", str(Path(self.folder.name)/"test.db")))
        self.now = 1001000
        self.enterContext(patch.object(database, "_now", lambda: self.now//1000))
        database.init_db()
        self.service = MqttRealtimeService(now_fn=lambda: self.now/1000)

    def send(self, sequence):
        self.now = 1000000+sequence*1000
        return self.service.ingest_message(device_topic("test", "features", "up"), json.dumps(packet(sequence)).encode())

    def test_mqtt_keeps_only_latest_window_without_fabricating_report_or_runtime(self):
        self.assertIn(device_topic("test", "features", "up"), allowed_device_publish_topics("test"))
        first = self.send(1)
        self.assertFalse(first["observation"]["automatic_allowed"])
        self.now += 1000
        self.assertEqual(self.service.ingest_features("test", json.dumps(packet(1)).encode())["status"], "duplicate")
        self.assertEqual(database.get_feature_snapshot("test")["received_at"], 1001)
        for sequence in range(2, 6):
            self.send(sequence)
        self.assertEqual(database.get_feature_snapshot("test")["packet"]["sequence"], 5)
        conn = database.get_conn()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM feature_runtime_status").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM device_commands").fetchone()[0], 0)
        finally:
            conn.close()
        self.assertEqual(database.get_runtime_snapshot("test"), {})
        with self.assertRaises(ValueError):
            self.service.ingest_features("other-device", json.dumps(packet(6)).encode())
        with self.assertRaises(ValueError):
            self.service.ingest_features("test", b"x"*2049)

    def test_actual_c_wire_packet_is_accepted_by_http_and_sqlite(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/"device-link"
            link = ROOT/"firmware/components/device_link"
            includes = [ROOT/"tests/esp_stubs", ROOT/"tests/vendor/cJSON",
                *[ROOT/f"firmware/components/{name}/include" for name in
                  ("device_link", "acoustic_features", "haptic", "actuation_guard", "mqtt_mgr", "device_control")]]
            subprocess.run(["clang", "-std=c11", "-Wno-deprecated-declarations",
                *[flag for path in includes for flag in ("-I", str(path))],
                str(ROOT/"tests/device_link_test.c"), str(link/"link_frames.c"),
                str(ROOT/"tests/vendor/cJSON/cJSON.c"), "-lm", "-o", str(output)], check=True)
            wire = json.loads(subprocess.check_output([str(output), "--features"], text=True))
        FeatureWindow(**wire)
        app = FastAPI()
        app.include_router(events.router)
        with TestClient(app) as client, patch("app.mqtt_service.get_mqtt_service", return_value=self.service), \
                patch.object(events, "require_device_key"), patch.object(events, "require_user_device_access"):
            response = client.post("/api/v1/device/test/features", json=wire)
            self.assertEqual(response.status_code, 200, response.text)
            latest = client.get("/api/v1/device/test/features/latest").json()
            self.assertEqual(latest["packet"]["session_id"], wire["session_id"])
            self.assertAlmostEqual(latest["packet"]["periodicity"], .9, places=6)
            self.assertFalse(latest["observation"]["automatic_allowed"])
            self.assertNotIn("data_b64", latest["packet"])

    def test_http_feature_ingress_and_readback_keep_auth_boundaries(self):
        app = FastAPI()
        app.include_router(events.router)
        with TestClient(app) as client, patch("app.mqtt_service.get_mqtt_service", return_value=self.service), \
                patch.object(events, "require_device_key") as device_auth, \
                patch.object(events, "require_user_device_access") as user_auth:
            response = client.post("/api/v1/device/test/features", json=packet(1), headers={"X-Device-Key": "test-key"})
            self.assertEqual(response.status_code, 200)
            device_auth.assert_called_with("test", "test-key")
            latest = client.get("/api/v1/device/test/features/latest", headers={"Authorization": "Bearer test-user"})
            self.assertEqual(latest.json()["packet"]["sequence"], 1)
            user_auth.assert_called_with("Bearer test-user", "test")
            device_auth.side_effect = HTTPException(status_code=403)
            self.assertEqual(client.post("/api/v1/device/test/features", json=packet(2)).status_code, 403)
            user_auth.side_effect = HTTPException(status_code=401)
            self.assertEqual(client.get("/api/v1/device/test/features/latest").status_code, 401)

    def test_pending_global_stop_is_prioritized_retried_and_requires_readback(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        client = Mock()
        client.publish.return_value = SimpleNamespace(rc=0)
        self.service._client = client
        self.service._connected = True
        database.create_device_command("test", "set_light", {"patch": {"enabled": True}}, ttl_seconds=60)
        stop = database.create_device_command("test", "stop_all", {}, ttl_seconds=60)
        snapshot = {"sequence": 1, "session_id": "boot-a", "capabilities": {"actuation_guard": 1}, "stop_latched": False}
        self.service.ingest_message(device_topic("test", "telemetry", "up"), json.dumps(snapshot).encode())
        self.assertTrue(client.publish.called)
        wire = json.loads(client.publish.call_args.args[1])
        self.assertEqual(wire["command_id"], stop["command_id"])
        self.assertFalse(client.publish.call_args.kwargs["retain"])
        # Delivery/HTTP success alone does not establish stopped outputs.
        ack = {"command_id": stop["command_id"], "status": "applied", "readback": {}}
        result = self.service.ingest_message(device_topic("test", "acks", "up"), json.dumps(ack).encode())
        self.assertEqual(result["command"]["status"], "readback-mismatch")
        confirmed = database.create_device_command("test", "stop_all", {}, ttl_seconds=60)
        ack = {"command_id": confirmed["command_id"], "status": "applied",
               "readback": {"vibration_level": 0, "stop_latched": True, "outputs_stopped": True}}
        result = self.service.ingest_message(device_topic("test", "acks", "up"), json.dumps(ack).encode())
        self.assertEqual(result["command"]["status"], "applied")

    def test_global_stop_endpoint_is_idempotent_and_write_authorized(self):
        app = FastAPI()
        app.include_router(device_runtime.router)
        with TestClient(app) as client, patch("app.mqtt_service.get_mqtt_service", return_value=self.service), \
                patch.object(device_runtime, "require_user_device_access") as auth:
            route = "/api/v1/device/test/outputs/stop"
            first = client.post(route, json={"request_id": "test-stop-1"}, headers={"Authorization": "Bearer test-user"})
            self.assertEqual(first.status_code, 200)
            self.assertNotEqual(first.json()["status"], "applied")
            auth.assert_called_with("Bearer test-user", "test", write=True)
            second = client.post(route, json={"request_id": "test-stop-1"})
            self.assertEqual(first.json()["command"]["command_id"], second.json()["command"]["command_id"])
            auth.side_effect = HTTPException(status_code=403)
            self.assertEqual(client.post(route, json={"request_id": "other"}).status_code, 403)


if __name__ == "__main__":
    unittest.main()
