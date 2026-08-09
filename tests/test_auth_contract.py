from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.errors import APIError
from app.core.security import create_access_token, decode_access_token
from app.main import app
from app.models.user import User, UserRole
from app.modules.auth.schemas import LoginRequest, UserProfile


def test_login_schema_uses_flutter_contract_and_normalizes_employee_id() -> None:
    payload = LoginRequest.model_validate(
        {"userId": " emp1001 ", "password": "long-enough-password", "role": "EMPLOYEE"}
    )

    assert payload.employee_id == "EMP1001"
    assert payload.role is UserRole.EMPLOYEE


def test_user_profile_does_not_expose_password_hash() -> None:
    user = User(
        id=uuid4(),
        employee_id="EMP1001",
        employee_name="Aryan Jain",
        email="aryan@example.com",
        password_hash="must-not-be-exposed",
        role=UserRole.EMPLOYEE,
        is_active=True,
        created_at=datetime.now(UTC),
    )

    profile = UserProfile.model_validate(user).model_dump(by_alias=True)

    assert profile["userId"] == "EMP1001"
    assert "password_hash" not in profile
    assert "passwordHash" not in profile


def test_access_token_is_signed_and_contains_session_claim() -> None:
    user_id = uuid4()
    session_id = uuid4()
    token = create_access_token(user_id=user_id, session_id=session_id, role=UserRole.MANAGER)

    claims = decode_access_token(token)

    assert claims.user_id == user_id
    assert claims.session_id == session_id
    assert claims.role is UserRole.MANAGER
    with pytest.raises(APIError, match="Invalid or expired access token"):
        decode_access_token(f"{token}corrupted")


def test_health_and_unauthorized_response_use_expected_contract() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        unauthorized = client.get("/api/v1/auth/me")

    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert unauthorized.status_code == 401
    assert unauthorized.json() == {
        "success": False,
        "data": None,
        "error": {"code": "UNAUTHORIZED", "message": "A bearer access token is required"},
    }


def test_openapi_exposes_the_authentication_endpoints() -> None:
    expected_paths = {
        "/api/v1/auth/login",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
        "/api/v1/auth/logout-all",
        "/api/v1/auth/me",
        "/api/v1/auth/users",
    }

    assert expected_paths.issubset(app.openapi()["paths"])
