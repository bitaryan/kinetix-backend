"""API tests for punch-in / location trail endpoints."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.rate_limit import _limiter
from tests.helpers import ADMIN_PASSWORD, EMPLOYEE_PASSWORD, login

TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t"
    b"\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e"
    b"\x1d\x1a\x1c\x1c $.\' \",#\x1c\x1c(7),01444\x1f\'9=82<.342"
    b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
    b"\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00"
    b"\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b"
    b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xaa\xff\xd9"
)


def _auth_header(client: TestClient, *, user_id: str, password: str, role: str) -> dict[str, str]:
    result = login(client, user_id=user_id, password=password, role=role)
    assert result["response"].status_code == 200
    token = result["body"]["data"]["accessToken"]
    return {"Authorization": f"Bearer {token}"}


def _image_files() -> dict:
    return {
        "selfie": ("selfie.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
        "openingOdoImage": ("odo.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
    }


def _punch_in(
    client: TestClient,
    headers: dict[str, str],
    *,
    opening_odo_km: str = "1234.50",
    latitude: str = "28.6139",
    longitude: str = "77.2090",
) -> dict:
    response = client.post(
        "/api/v1/attendance/punch-in",
        headers=headers,
        data={
            "openingOdoKm": opening_odo_km,
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": "12.5",
            "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        },
        files=_image_files(),
    )
    return {"response": response, "body": response.json()}


class TestPunchInFlow:
    def test_punch_in_requires_auth(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/attendance/punch-in",
            data={"openingOdoKm": "1", "latitude": "1", "longitude": "1"},
            files=_image_files(),
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"

    def test_admin_cannot_punch_in(self, client: TestClient, admin_user) -> None:
        headers = _auth_header(
            client, user_id="ADM1001", password=ADMIN_PASSWORD, role="ADMIN"
        )
        result = _punch_in(client, headers)
        assert result["response"].status_code == 403
        assert result["body"]["error"]["code"] == "FORBIDDEN"

    def test_punch_in_success_and_current_session(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        result = _punch_in(client, headers)
        assert result["response"].status_code == 201
        body = result["body"]
        assert body["success"] is True
        assert body["data"]["status"] == "punched_in"
        assert body["data"]["openingOdoKm"] == "1234.50"
        assert body["data"]["locationMode"] == "continuous"
        session_id = body["data"]["sessionId"]

        current = client.get("/api/v1/attendance/current", headers=headers)
        assert current.status_code == 200
        current_body = current.json()
        assert current_body["data"]["punchedIn"] is True
        assert current_body["data"]["session"]["sessionId"] == session_id

        # Verification images landed on disk.
        upload_root = Path("uploads/test")
        saved = list(upload_root.rglob("selfie.jpg"))
        assert len(saved) == 1

    def test_double_punch_in_rejected(self, client: TestClient, employee_user) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        first = _punch_in(client, headers)
        assert first["response"].status_code == 201
        second = _punch_in(client, headers)
        assert second["response"].status_code == 409
        assert second["body"]["error"]["code"] == "ALREADY_PUNCHED_IN"

    def test_punch_in_rejects_non_image(self, client: TestClient, employee_user) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        response = client.post(
            "/api/v1/attendance/punch-in",
            headers=headers,
            data={"openingOdoKm": "10", "latitude": "28.6", "longitude": "77.2"},
            files={
                "selfie": ("selfie.txt", BytesIO(b"not-an-image"), "text/plain"),
                "openingOdoImage": ("odo.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
            },
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_IMAGE"

    def test_punch_in_rejects_spoofed_content_type(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        response = client.post(
            "/api/v1/attendance/punch-in",
            headers=headers,
            data={"openingOdoKm": "10", "latitude": "28.6", "longitude": "77.2"},
            files={
                "selfie": ("selfie.jpg", BytesIO(b"not-really-jpeg"), "image/jpeg"),
                "openingOdoImage": ("odo.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
            },
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_IMAGE"
        assert list(Path("uploads/test").rglob("*")) == [] or not any(
            Path("uploads/test").rglob("selfie.*")
        )

    def test_punch_in_rejects_naive_captured_at(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        response = client.post(
            "/api/v1/attendance/punch-in",
            headers=headers,
            data={
                "openingOdoKm": "10",
                "latitude": "28.6",
                "longitude": "77.2",
                "capturedAt": "2026-08-09T10:15:00",
            },
            files=_image_files(),
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"

    def test_punch_in_rejects_stale_captured_at(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        stale = (datetime.now(UTC) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
        response = client.post(
            "/api/v1/attendance/punch-in",
            headers=headers,
            data={
                "openingOdoKm": "10",
                "latitude": "28.6",
                "longitude": "77.2",
                "capturedAt": stale,
            },
            files=_image_files(),
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "STALE_TIMESTAMP"

    def test_punch_in_rejects_oversized_image(
        self, client: TestClient, employee_user, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("MAX_UPLOAD_BYTES", "1024")
        get_settings.cache_clear()
        try:
            headers = _auth_header(
                client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
            )
            oversized = TINY_JPEG + (b"\x00" * 2000)
            response = client.post(
                "/api/v1/attendance/punch-in",
                headers=headers,
                data={"openingOdoKm": "10", "latitude": "28.6", "longitude": "77.2"},
                files={
                    "selfie": ("selfie.jpg", BytesIO(oversized), "image/jpeg"),
                    "openingOdoImage": ("odo.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
                },
            )
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "IMAGE_TOO_LARGE"
        finally:
            monkeypatch.setenv("MAX_UPLOAD_BYTES", "5242880")
            get_settings.cache_clear()


class TestLocationPingAndPunchOut:
    def test_location_ping_appends_while_punched_in(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]

        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6140,
                "longitude": 77.2091,
                "accuracy": 8.0,
                "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "battery": 80,
                "speed": 12.5,
            },
        )
        assert ping.status_code == 200
        ping_body = ping.json()
        assert ping_body["data"]["accepted"] is True
        assert ping_body["data"]["pingId"] is not None

    def test_location_ping_soft_fails_naive_timestamp(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]

        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": "2026-08-09T10:15:00",
            },
        )
        assert ping.status_code == 200
        assert ping.json()["data"]["accepted"] is False
        assert ping.json()["data"]["reason"] == "INVALID_TIMESTAMP"

    def test_location_ping_soft_fails_after_punch_out(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]

        punch_out = client.post(
            "/api/v1/attendance/punch-out",
            headers=headers,
            data={
                "closingOdoKm": "1250.00",
                "latitude": "28.6150",
                "longitude": "77.2100",
            },
            files={
                "closingOdoImage": ("closing.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
            },
        )
        assert punch_out.status_code == 200
        assert punch_out.json()["data"]["status"] == "punched_out"

        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
        )
        assert ping.status_code == 200
        assert ping.json()["data"]["accepted"] is False
        assert ping.json()["data"]["reason"] == "SESSION_NOT_ACTIVE"

        current = client.get("/api/v1/attendance/current", headers=headers)
        assert current.json()["data"]["punchedIn"] is False

    def test_punch_out_without_session_rejected(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punch_out = client.post(
            "/api/v1/attendance/punch-out",
            headers=headers,
            data={
                "closingOdoKm": "1250.00",
                "latitude": "28.6150",
                "longitude": "77.2100",
            },
            files={
                "closingOdoImage": ("closing.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
            },
        )
        assert punch_out.status_code == 409
        assert punch_out.json()["error"]["code"] == "NOT_PUNCHED_IN"

    def test_punch_out_rejects_lower_odo(self, client: TestClient, employee_user) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        assert _punch_in(client, headers)["response"].status_code == 201
        punch_out = client.post(
            "/api/v1/attendance/punch-out",
            headers=headers,
            data={
                "closingOdoKm": "1000.00",
                "latitude": "28.6150",
                "longitude": "77.2100",
            },
            files={
                "closingOdoImage": ("closing.jpg", BytesIO(TINY_JPEG), "image/jpeg"),
            },
        )
        assert punch_out.status_code == 400
        assert punch_out.json()["error"]["code"] == "INVALID_ODO_READING"

    def test_location_ping_rejects_stale_softly(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]
        stale = (datetime.now(UTC) - timedelta(days=2)).isoformat().replace("+00:00", "Z")

        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": stale,
            },
        )
        assert ping.status_code == 200
        assert ping.json()["data"]["accepted"] is False
        assert ping.json()["data"]["reason"] == "STALE_PING"

    def test_location_ping_rate_limited(
        self, client: TestClient, employee_user, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOCATION_PING_RATE_LIMIT_PER_MINUTE", "2")
        get_settings.cache_clear()
        _limiter._events.clear()

        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]
        payload = {
            "sessionId": session_id,
            "latitude": 28.6160,
            "longitude": 77.2110,
            "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        }
        assert (
            client.post(
                "/api/v1/attendance/location-ping", headers=headers, json=payload
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/attendance/location-ping", headers=headers, json=payload
            ).status_code
            == 200
        )
        limited = client.post(
            "/api/v1/attendance/location-ping", headers=headers, json=payload
        )

        monkeypatch.setenv("LOCATION_PING_RATE_LIMIT_PER_MINUTE", "1000")
        get_settings.cache_clear()
        _limiter._events.clear()

        assert limited.status_code == 429
        assert limited.json()["error"]["code"] == "RATE_LIMITED"

    def test_location_ping_soft_fails_when_too_frequent(
        self, client: TestClient, employee_user, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOCATION_PING_MIN_INTERVAL_SECONDS", "30")
        get_settings.cache_clear()
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]
        # Punch-in already wrote the first trail point; an immediate ping is too frequent.
        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
        )
        monkeypatch.setenv("LOCATION_PING_MIN_INTERVAL_SECONDS", "0")
        get_settings.cache_clear()
        assert ping.status_code == 200
        assert ping.json()["data"]["accepted"] is False
        assert ping.json()["data"]["reason"] == "TOO_FREQUENT"

    def test_location_ping_batch_flushes_offline_queue(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]
        base = datetime.now(UTC)
        batch = client.post(
            "/api/v1/attendance/location-pings",
            headers=headers,
            json={
                "sessionId": session_id,
                "pings": [
                    {
                        "latitude": 28.61 + (i * 0.001),
                        "longitude": 77.20 + (i * 0.001),
                        "capturedAt": (base + timedelta(seconds=30 * (i + 1)))
                        .isoformat()
                        .replace("+00:00", "Z"),
                    }
                    for i in range(5)
                ],
            },
        )
        assert batch.status_code == 200
        body = batch.json()["data"]
        assert body["acceptedCount"] == 5
        assert body["rejectedCount"] == 0
        assert len(body["items"]) == 5
        assert all(item["accepted"] for item in body["items"])

    def test_location_ping_rejects_when_session_trail_full(
        self, client: TestClient, employee_user, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOCATION_PING_MAX_PER_SESSION", "2")
        get_settings.cache_clear()
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        punched = _punch_in(client, headers)
        session_id = punched["body"]["data"]["sessionId"]
        # First post-punch ping fills the remaining slot (punch-in already stored 1).
        first = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": (datetime.now(UTC) + timedelta(seconds=10))
                .isoformat()
                .replace("+00:00", "Z"),
            },
        )
        assert first.status_code == 200
        assert first.json()["data"]["accepted"] is True

        second = client.post(
            "/api/v1/attendance/location-ping",
            headers=headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6170,
                "longitude": 77.2120,
                "capturedAt": (datetime.now(UTC) + timedelta(seconds=20))
                .isoformat()
                .replace("+00:00", "Z"),
            },
        )
        monkeypatch.setenv("LOCATION_PING_MAX_PER_SESSION", "6000")
        get_settings.cache_clear()
        assert second.status_code == 200
        assert second.json()["data"]["accepted"] is False
        assert second.json()["data"]["reason"] == "SESSION_TRAIL_FULL"


class TestAdminLocationSettings:
    def test_admin_can_switch_to_single_mode(
        self, client: TestClient, admin_user, employee_user
    ) -> None:
        admin_headers = _auth_header(
            client, user_id="ADM1001", password=ADMIN_PASSWORD, role="ADMIN"
        )
        employee_headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )

        update = client.patch(
            "/api/v1/admin/location-settings",
            headers=admin_headers,
            json={"locationMode": "single"},
        )
        assert update.status_code == 200
        assert update.json()["data"]["locationMode"] == "single"

        punched = _punch_in(client, employee_headers)
        session_id = punched["body"]["data"]["sessionId"]
        assert punched["body"]["data"]["locationMode"] == "single"

        ping = client.post(
            "/api/v1/attendance/location-ping",
            headers=employee_headers,
            json={
                "sessionId": session_id,
                "latitude": 28.6160,
                "longitude": 77.2110,
                "capturedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
        )
        assert ping.status_code == 200
        assert ping.json()["data"]["accepted"] is False
        assert ping.json()["data"]["reason"] == "SINGLE_LOCATION_MODE"

    def test_employee_cannot_change_location_settings(
        self, client: TestClient, employee_user
    ) -> None:
        headers = _auth_header(
            client, user_id="EMP1001", password=EMPLOYEE_PASSWORD, role="EMPLOYEE"
        )
        response = client.patch(
            "/api/v1/admin/location-settings",
            headers=headers,
            json={"locationMode": "single"},
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"
