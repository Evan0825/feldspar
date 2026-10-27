"""Reference HTTPS synchronization client for a local device runtime."""
from __future__ import annotations

from typing import Optional

import httpx

from app.agent.device_runtime import LocalInterventionRuntime


class DeviceCloudClient:
    """Synchronize commands, runtime snapshots and structured events.

    This client is suitable for host-side integration tests and Linux-class
    prototypes. ESP32 firmware should implement the same HTTP contract with its
    native TLS/network stack.
    """

    def __init__(
        self,
        base_url: str,
        device_id: str,
        device_key: str = "",
        timeout_seconds: float = 5,
    ):
        self.base_url = base_url.rstrip("/")
        self.device_id = device_id
        self.headers = {"Content-Type": "application/json"}
        if device_key:
            self.headers["X-Device-Key"] = device_key
        self.client = httpx.Client(
            base_url=self.base_url,
            headers=self.headers,
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
        )

    def close(self):
        self.client.close()

    def bootstrap(self, runtime: LocalInterventionRuntime) -> dict:
        response = self.client.get(f"/api/v1/device/{self.device_id}/bootstrap")
        response.raise_for_status()
        payload = response.json()
        runtime.apply_bootstrap(payload)
        return payload

    def sync_once(self, runtime: LocalInterventionRuntime) -> dict:
        command_result = self._poll_and_apply_command(runtime)
        pending = runtime.pending_events()
        uploaded = 0
        if pending:
            response = self.client.post(
                "/api/v1/events/batch",
                json={"device_id": self.device_id, "events": pending},
            )
            response.raise_for_status()
            uploaded = int(response.json().get("inserted", 0)) + int(
                response.json().get("duplicates", 0)
            )
            if uploaded != len(pending):
                raise RuntimeError(
                    f"event acknowledgement mismatch: sent={len(pending)} acknowledged={uploaded}"
                )
            runtime.acknowledge_uploaded_events(len(pending))

        snapshot = runtime.snapshot()
        response = self.client.post(
            f"/api/v1/device/{self.device_id}/runtime/snapshot",
            json=snapshot,
        )
        response.raise_for_status()
        return {
            "uploaded_events": uploaded,
            "snapshot_sequence": snapshot["sequence"],
            "command": command_result,
        }

    def _poll_and_apply_command(self, runtime: LocalInterventionRuntime) -> Optional[dict]:
        response = self.client.post(f"/api/v1/device/{self.device_id}/commands/poll")
        response.raise_for_status()
        command = response.json().get("command")
        if not command:
            return None
        result = runtime.apply_command(command)
        ack = self.client.post(
            f"/api/v1/device/{self.device_id}/commands/{command['command_id']}/ack",
            json=result,
        )
        ack.raise_for_status()
        return ack.json()
