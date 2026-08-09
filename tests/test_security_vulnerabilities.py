"""
Security regression tests for the GPSS auth API.

Asserts that previously audited vulnerabilities remain fixed.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import AsyncSessionLocal
from app.core.rate_limit import _limiter
from app.core.security import create_access_token, hash_password
from app.models.session import ActiveSession
from app.models.user import User, UserRole
from tests.helpers import ADMIN_PASSWORD, EMPLOYEE_PASSWORD, login


class TestSecureControls:
    def test_password_hash_never_returned_in_login_or_me(
        self, client: TestClient, employee_user
    ) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        login_body = login_result["body"]
        token = login_body["data"]["accessToken"]
        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        ).json()

        for payload in (login_body["data"]["user"], me["data"]):
            serialized = str(payload).lower()
            assert "password" not in serialized
            assert "argon" not in serialized

    def test_jwt_rejects_alg_none_and_wrong_secret(
        self, client: TestClient, employee_user
    ) -> None:
        settings = get_settings()
        forged_none = jwt.encode(
            {
                "sub": str(employee_user.id),
                "sid": str(uuid4()),
                "role": "ADMIN",
                "iss": settings.jwt_issuer,
                "aud": settings.jwt_audience,
            },
            key="",
            algorithm="none",
        )
        forged_hs = jwt.encode(
            {
                "sub": str(employee_user.id),
                "sid": str(uuid4()),
                "role": "ADMIN",
                "iss": settings.jwt_issuer,
                "aud": settings.jwt_audience,
            },
            key="totally-wrong-secret-key-0123456789abcdef",
            algorithm="HS256",
        )

        for token in (forged_none, forged_hs):
            response = client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert response.status_code == 401

    def test_privilege_escalation_via_jwt_role_claim_is_blocked(
        self, client: TestClient, employee_user
    ) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        valid = login_result["body"]["data"]["accessToken"]
        claims = jwt.decode(
            valid,
            get_settings().jwt_secret_key,
            algorithms=["HS256"],
            audience=get_settings().jwt_audience,
            issuer=get_settings().jwt_issuer,
        )
        forged = create_access_token(
            user_id=employee_user.id,
            session_id=UUID(claims["sid"]),
            role=UserRole.ADMIN,
        )
        response = client.post(
            "/api/v1/auth/users",
            headers={"Authorization": f"Bearer {forged}"},
            json={
                "userId": "HACK001",
                "employeeName": "Hacker",
                "email": "hacker@example.com",
                "password": "Brand-new-pass12",
                "role": "ADMIN",
            },
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"

    def test_cors_does_not_reflect_arbitrary_origin(self, client: TestClient) -> None:
        response = client.options(
            "/api/v1/auth/login",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        allow_origin = response.headers.get("access-control-allow-origin")
        assert allow_origin != "https://evil.example"
        assert allow_origin != "*"

    def test_refresh_cookie_is_httponly(self, client: TestClient, employee_user) -> None:
        result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        set_cookie = result["response"].headers.get("set-cookie", "").lower()
        assert "httponly" in set_cookie
        assert "refresh_token=" in set_cookie

    def test_security_headers_present(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.headers.get("x-content-type-options") == "nosniff"
        assert response.headers.get("x-frame-options") == "DENY"


class TestVulnerabilityFixes:
    def test_refresh_reuse_revokes_stolen_session(
        self, client: TestClient, employee_user
    ) -> None:
        victim_login = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        stolen_refresh = victim_login["response"].cookies.get("refresh_token")
        assert stolen_refresh

        attacker = TestClient(client.app)
        attacker.cookies.set("refresh_token", stolen_refresh, path="/api/v1/auth")
        attacker_refresh = attacker.post("/api/v1/auth/refresh")
        assert attacker_refresh.status_code == 200
        attacker_access = attacker_refresh.json()["data"]["accessToken"]

        victim_retry = client.post("/api/v1/auth/refresh")
        assert victim_retry.status_code == 401

        attacker_me = attacker.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {attacker_access}"},
        )
        assert attacker_me.status_code == 401

    def test_wrong_role_counts_toward_lockout(
        self, client: TestClient, employee_user
    ) -> None:
        for _ in range(5):
            result = login(
                client,
                user_id="EMP1001",
                password="wrong-password-xx",
                role="ADMIN",
            )
            assert result["response"].status_code == 401
            assert result["body"]["error"]["code"] == "INVALID_CREDENTIALS"

        locked = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        assert locked["response"].status_code == 401
        assert locked["body"]["error"]["code"] == "INVALID_CREDENTIALS"

    def test_locked_account_matches_unknown_user_response(
        self, client: TestClient, employee_user
    ) -> None:
        for _ in range(5):
            login(
                client,
                user_id="EMP1001",
                password="wrong-password-xx",
                role="EMPLOYEE",
            )

        locked = login(
            client,
            user_id="EMP1001",
            password="wrong-password-xx",
            role="EMPLOYEE",
        )
        unknown = login(
            client,
            user_id="NOSUCH99",
            password="wrong-password-xx",
            role="EMPLOYEE",
        )

        assert locked["response"].status_code == 401
        assert unknown["response"].status_code == 401
        assert locked["body"]["error"] == unknown["body"]["error"]

    def test_admin_cannot_provision_additional_admins(
        self, client: TestClient, admin_user
    ) -> None:
        admin_login = login(
            client,
            user_id="ADM1001",
            password=ADMIN_PASSWORD,
            role="ADMIN",
        )
        token = admin_login["body"]["data"]["accessToken"]
        response = client.post(
            "/api/v1/auth/users",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "userId": "ADM9999",
                "employeeName": "Peer Admin",
                "email": "peer-admin@example.com",
                "password": "Another-admin-12",
                "role": "ADMIN",
            },
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"

    def test_password_policy_rejects_weak_complexity(
        self, client: TestClient, admin_user
    ) -> None:
        admin_login = login(
            client,
            user_id="ADM1001",
            password=ADMIN_PASSWORD,
            role="ADMIN",
        )
        token = admin_login["body"]["data"]["accessToken"]
        response = client.post(
            "/api/v1/auth/users",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "userId": "EMPWEAK1",
                "employeeName": "Weak Pass",
                "email": "weak@example.com",
                "password": "aaaaaaaaaaaa",
                "role": "EMPLOYEE",
            },
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"

    def test_login_rate_limit_blocks_cross_account_spray(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOGIN_RATE_LIMIT_PER_MINUTE", "3")
        get_settings.cache_clear()
        _limiter._events.clear()

        async def seed() -> list[str]:
            ids: list[str] = []
            async with AsyncSessionLocal() as db:
                for i in range(5):
                    emp_id = f"STUF{i:04d}"
                    db.add(
                        User(
                            employee_id=emp_id,
                            employee_name=f"Stuff {i}",
                            email=f"stuff{i}@example.com",
                            password_hash=hash_password("Correct-pass-12"),
                            role=UserRole.EMPLOYEE,
                        )
                    )
                    ids.append(emp_id)
                await db.commit()
            return ids

        import asyncio

        employee_ids = asyncio.get_event_loop().run_until_complete(seed())
        results = [
            login(
                client,
                user_id=emp_id,
                password="wrong-password-xx",
                role="EMPLOYEE",
            )
            for emp_id in employee_ids
        ]
        statuses = [item["response"].status_code for item in results]
        codes = [item["body"]["error"]["code"] for item in results]

        monkeypatch.setenv("LOGIN_RATE_LIMIT_PER_MINUTE", "1000")
        get_settings.cache_clear()
        _limiter._events.clear()

        assert 401 in statuses
        assert 429 in statuses
        assert "RATE_LIMITED" in codes
        assert "INVALID_CREDENTIALS" in codes


class TestSessionIntegrity:
    @pytest.mark.asyncio
    async def test_access_token_for_revoked_session_is_rejected(
        self, client: TestClient, employee_user
    ) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token = login_result["body"]["data"]["accessToken"]
        claims = jwt.decode(
            token,
            get_settings().jwt_secret_key,
            algorithms=["HS256"],
            audience=get_settings().jwt_audience,
            issuer=get_settings().jwt_issuer,
        )

        async with AsyncSessionLocal() as db:
            session = await db.get(ActiveSession, UUID(claims["sid"]))
            assert session is not None
            session.is_revoked = True
            await db.commit()

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_refresh_token_stored_as_hash_only(
        self, client: TestClient, employee_user
    ) -> None:
        result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        raw_refresh = result["response"].cookies.get("refresh_token")
        assert raw_refresh

        async with AsyncSessionLocal() as db:
            rows = (await db.execute(select(ActiveSession))).scalars().all()
            assert len(rows) == 1
            assert rows[0].refresh_token_hash != raw_refresh
            assert len(rows[0].refresh_token_hash) == 64
