"""Shared helpers for API tests (importable as a module)."""

from __future__ import annotations

from fastapi.testclient import TestClient

ADMIN_PASSWORD = "Admin-secure-pass-12"
EMPLOYEE_PASSWORD = "Employee-pass-12"
MANAGER_PASSWORD = "Manager-pass-12"


def login(
    client: TestClient,
    *,
    user_id: str,
    password: str,
    role: str,
) -> dict:
    response = client.post(
        "/api/v1/auth/login",
        json={"userId": user_id, "password": password, "role": role},
    )
    return {"response": response, "body": response.json()}
