"""Actual application entry, temporary SQLite, in-process HTTP; no cloud calls."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
if len(sys.argv) == 1:
    # Do not inherit API keys, proxy settings, database or cloud service config.
    env = {k: v for k, v in os.environ.items() if k in {'PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'LANG'}}
    with tempfile.TemporaryDirectory(prefix='feldspar-smoke-') as folder:
        env.update(SNOOZMATE_DB_BACKEND='sqlite', SNOOZMATE_DB_PATH=str(Path(folder)/'test.db'),
            SNOOZMATE_MQTT_ENABLED='false', SNOOZMATE_MQTT_AUDIO_ENABLED='false',
            SNOOZMATE_MQTT_HTTP_AUTH_ENABLED='false', SNOOZMATE_ENABLE_CLOUD_AGENT_DEBUG='false',
            SNOOZMATE_SEED_DEMO_DATA='false', SNOOZMATE_ALLOW_SIMULATED_EXPERIENCE_DATA='false',
            SNOOZMATE_CLOUDBASE_HEADER_AUTH_ENABLED='false', SNOOZMATE_AUTH_MODE='production')
        raise SystemExit(subprocess.run([sys.executable, __file__, '--isolated'], env=env).returncode)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'backend'))
from fastapi.testclient import TestClient
from main import app
with TestClient(app) as client:
    for route in ('/healthz', '/readyz', '/openapi.json'):
        response = client.get(route)
        assert response.status_code == 200, (route, response.status_code)
    diagnostics = client.get('/diagnostics').json()
    assert diagnostics['llm']['configured'] is False
    report = client.get('/api/v1/device/test/features/latest')
    assert report.status_code in (401, 403), report.text
print('PASS: real app startup, health/readiness/OpenAPI, no configured LLM, unauthenticated feature access rejected. In-process only.')
