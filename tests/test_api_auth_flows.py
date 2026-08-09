"""Functional API test cases for the authentication module."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.helpers import ADMIN_PASSWORD, EMPLOYEE_PASSWORD, MANAGER_PASSWORD, login


class TestHealthAndContract:
    def test_health_returns_ok(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_me_without_token_returns_unauthorized(self, client: TestClient) -> None:
        response = client.get("/api/v1/auth/me")
        assert response.status_code == 401
        body = response.json()
        assert body["success"] is False
        assert body["data"] is None
        assert body["error"]["code"] == "UNAUTHORIZED"

    def test_login_validation_rejects_short_password(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/auth/login",
            json={"userId": "EMP1001", "password": "short", "role": "EMPLOYEE"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


class TestLoginFlow:
    def test_login_success_returns_access_token_and_httponly_cookie(
        self, client: TestClient, employee_user
    ) -> None:
        result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        response = result["response"]
        body = result["body"]

        assert response.status_code == 200
        assert body["success"] is True
        assert body["error"] is None
        assert body["data"]["tokenType"] == "bearer"
        assert body["data"]["expiresIn"] == 15 * 60
        assert isinstance(body["data"]["accessToken"], str)
        assert body["data"]["user"]["userId"] == "EMP1001"
        assert "password" not in body["data"]["user"]
        assert "passwordHash" not in body["data"]["user"]
        assert "password_hash" not in body["data"]["user"]

        cookie = response.cookies.get("refresh_token")
        assert cookie is not None
        set_cookie = response.headers.get("set-cookie", "").lower()
        assert "httponly" in set_cookie
        assert "samesite=strict" in set_cookie

    def test_login_wrong_password_returns_invalid_credentials(
        self, client: TestClient, employee_user
    ) -> None:
        result = login(
            client,
            user_id="EMP1001",
            password="wrong-password-xx",
            role="EMPLOYEE",
        )
        assert result["response"].status_code == 401
        assert result["body"]["error"]["code"] == "INVALID_CREDENTIALS"

    def test_login_unknown_user_returns_invalid_credentials(self, client: TestClient) -> None:
        result = login(
            client,
            user_id="NOSUCH1",
            password="some-password",
            role="EMPLOYEE",
        )
        assert result["response"].status_code == 401
        assert result["body"]["error"]["code"] == "INVALID_CREDENTIALS"

    def test_login_wrong_role_returns_invalid_credentials(
        self, client: TestClient, employee_user
    ) -> None:
        result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="ADMIN",
        )
        assert result["response"].status_code == 401
        assert result["body"]["error"]["code"] == "INVALID_CREDENTIALS"

    def test_account_locks_after_five_failed_password_attempts(
        self, client: TestClient, employee_user
    ) -> None:
        for _ in range(4):
            result = login(
                client,
                user_id="EMP1001",
                password="wrong-password-xx",
                role="EMPLOYEE",
            )
            assert result["response"].status_code == 401

        fifth = login(
            client,
            user_id="EMP1001",
            password="wrong-password-xx",
            role="EMPLOYEE",
        )
        assert fifth["response"].status_code == 401
        assert fifth["body"]["error"]["code"] == "INVALID_CREDENTIALS"

        # Correct password should still be rejected while locked (same client error).
        locked = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        assert locked["response"].status_code == 401
        assert locked["body"]["error"]["code"] == "INVALID_CREDENTIALS"


class TestProtectedRoutes:
    def test_me_returns_profile_with_valid_token(
        self, client: TestClient, employee_user
    ) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token = login_result["body"]["data"]["accessToken"]

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["userId"] == "EMP1001"
        assert body["data"]["role"] == "EMPLOYEE"

    def test_me_rejects_tampered_token(self, client: TestClient, employee_user) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token = login_result["body"]["data"]["accessToken"] + "tampered"

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"

    def test_logout_revokes_access_token(self, client: TestClient, employee_user) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token = login_result["body"]["data"]["accessToken"]

        logout = client.post(
            "/api/v1/auth/logout",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert logout.status_code == 200
        assert logout.json()["data"]["message"] == "Successfully logged out"

        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert me.status_code == 401
        assert me.json()["error"]["code"] == "UNAUTHORIZED"

    def test_logout_all_revokes_all_sessions(
        self, client: TestClient, employee_user
    ) -> None:
        first = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        second = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token_a = first["body"]["data"]["accessToken"]
        token_b = second["body"]["data"]["accessToken"]

        logout_all = client.post(
            "/api/v1/auth/logout-all",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert logout_all.status_code == 200

        for token in (token_a, token_b):
            me = client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert me.status_code == 401


class TestRefreshFlow:
    def test_refresh_rotates_cookie_and_issues_new_access_token(
        self, client: TestClient, employee_user
    ) -> None:
        login_result = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        old_access = login_result["body"]["data"]["accessToken"]
        old_refresh = login_result["response"].cookies.get("refresh_token")
        assert old_refresh

        refresh = client.post("/api/v1/auth/refresh")
        assert refresh.status_code == 200
        new_access = refresh.json()["data"]["accessToken"]
        new_refresh = refresh.cookies.get("refresh_token")

        # Refresh cookie must rotate. Access JWTs may match when minted in the same second.
        assert new_refresh is not None
        assert new_refresh != old_refresh
        assert isinstance(new_access, str) and len(new_access) > 20
        _ = old_access  # login issued an access token before rotation

        me = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {new_access}"},
        )
        assert me.status_code == 200

        # Old refresh cookie must no longer work.
        client.cookies.set("refresh_token", old_refresh, path="/api/v1/auth")
        stale = client.post("/api/v1/auth/refresh")
        assert stale.status_code == 401

    def test_refresh_without_cookie_returns_invalid_refresh_token(
        self, client: TestClient
    ) -> None:
        response = client.post("/api/v1/auth/refresh")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_REFRESH_TOKEN"


class TestRbacUserProvisioning:
    def test_admin_can_create_employee(
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
                "userId": "EMP2002",
                "employeeName": "New Hire",
                "email": "newhire@example.com",
                "password": "Brand-new-pass12",
                "role": "EMPLOYEE",
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert body["success"] is True
        assert body["data"]["userId"] == "EMP2002"
        assert body["data"]["role"] == "EMPLOYEE"

    def test_employee_cannot_create_users(
        self, client: TestClient, employee_user
    ) -> None:
        emp_login = login(
            client,
            user_id="EMP1001",
            password=EMPLOYEE_PASSWORD,
            role="EMPLOYEE",
        )
        token = emp_login["body"]["data"]["accessToken"]

        response = client.post(
            "/api/v1/auth/users",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "userId": "EMP3003",
                "employeeName": "Should Fail",
                "email": "fail@example.com",
                "password": "Brand-new-pass12",
                "role": "EMPLOYEE",
            },
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"

    def test_manager_cannot_create_users(
        self, client: TestClient, manager_user
    ) -> None:
        mgr_login = login(
            client,
            user_id="MGR1001",
            password=MANAGER_PASSWORD,
            role="MANAGER",
        )
        token = mgr_login["body"]["data"]["accessToken"]

        response = client.post(
            "/api/v1/auth/users",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "userId": "EMP4004",
                "employeeName": "Should Fail",
                "email": "fail2@example.com",
                "password": "Brand-new-pass12",
                "role": "EMPLOYEE",
            },
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"

    def test_duplicate_employee_id_returns_conflict(
        self, client: TestClient, admin_user, employee_user
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
                "userId": "EMP1001",
                "employeeName": "Dup",
                "email": "dup@example.com",
                "password": "Brand-new-pass12",
                "role": "EMPLOYEE",
            },
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "EMPLOYEE_ID_EXISTS"
