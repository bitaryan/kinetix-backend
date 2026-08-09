import os
import shutil
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

# Force deterministic test settings before any app module imports Settings.
os.environ["DATABASE_URL"] = "postgresql+asyncpg://gpss:gpss@localhost:5432/gpss"
os.environ["JWT_SECRET_KEY"] = (
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["COOKIE_SAMESITE"] = "strict"
os.environ["BACKEND_CORS_ORIGINS"] = "http://localhost:3000"
os.environ["LOGIN_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["REFRESH_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["LOCATION_PING_RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["LOCATION_PING_MIN_INTERVAL_SECONDS"] = "0"
os.environ["LOCATION_PING_MAX_PER_SESSION"] = "6000"
os.environ["LOCATION_PING_BATCH_MAX"] = "120"
os.environ["TRUSTED_PROXY_IPS"] = ""
os.environ["UPLOAD_DIR"] = "uploads/test"
os.environ["MAX_UPLOAD_BYTES"] = "5242880"
os.environ["DB_POOL_SIZE"] = "5"
os.environ["DB_MAX_OVERFLOW"] = "10"
os.environ["DB_POOL_TIMEOUT_SECONDS"] = "30"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.core.database import get_db_session
from app.main import app
from app.models.user import User, UserRole
from app.modules.attendance.location_mode_cache import clear_cached_location_mode
from app.modules.auth.schemas import CreateUserRequest
from app.modules.auth.service import AuthService
from tests.helpers import ADMIN_PASSWORD, EMPLOYEE_PASSWORD, MANAGER_PASSWORD

get_settings.cache_clear()
clear_cached_location_mode()

engine = create_async_engine(
    get_settings().database_url,
    pool_pre_ping=True,
    poolclass=NullPool,
)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
TEST_UPLOAD_DIR = Path(os.environ["UPLOAD_DIR"])


async def _override_get_db_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


@pytest.fixture(autouse=True)
async def clean_database() -> AsyncIterator[None]:
    """Start every test from an empty auth/attendance dataset."""
    clear_cached_location_mode()
    if TEST_UPLOAD_DIR.exists():
        shutil.rmtree(TEST_UPLOAD_DIR)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE TABLE location_pings, attendance_sessions, location_settings, "
                "active_sessions, users RESTART IDENTITY CASCADE"
            )
        )
        await conn.execute(
            text(
                "INSERT INTO location_settings (settings_id, singleton_key, location_mode) "
                "VALUES (gen_random_uuid(), 'default', 'continuous')"
            )
        )
    yield
    clear_cached_location_mode()
    if TEST_UPLOAD_DIR.exists():
        shutil.rmtree(TEST_UPLOAD_DIR)


@pytest.fixture
async def admin_user() -> User:
    async with AsyncSessionLocal() as db:
        return await AuthService(db).create_user(
            CreateUserRequest(
                employee_id="ADM1001",
                employee_name="Admin User",
                email="admin@example.com",
                password=ADMIN_PASSWORD,
                role=UserRole.ADMIN,
            ),
            allow_admin_role=True,
        )


@pytest.fixture
async def employee_user() -> User:
    async with AsyncSessionLocal() as db:
        return await AuthService(db).create_user(
            CreateUserRequest(
                employee_id="EMP1001",
                employee_name="Employee User",
                email="employee@example.com",
                password=EMPLOYEE_PASSWORD,
                role=UserRole.EMPLOYEE,
            )
        )


@pytest.fixture
async def manager_user() -> User:
    async with AsyncSessionLocal() as db:
        return await AuthService(db).create_user(
            CreateUserRequest(
                employee_id="MGR1001",
                employee_name="Manager User",
                email="manager@example.com",
                password=MANAGER_PASSWORD,
                role=UserRole.MANAGER,
            )
        )


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_db_session] = _override_get_db_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_db_session, None)
