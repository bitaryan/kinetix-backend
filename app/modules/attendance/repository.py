import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance import (
    AttendanceSession,
    AttendanceStatus,
    LocationMode,
    LocationPing,
    LocationSettings,
)
from app.models.user import User

LOCATION_SETTINGS_KEY = "default"


class AttendanceRepository:
    """ORM-only persistence for attendance sessions and location pings."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def lock_user(self, user_id: uuid.UUID) -> User | None:
        """Serialize punch-in/out for a user even when no active session row exists."""
        result = await self.db.execute(
            select(User).where(User.id == user_id).with_for_update()
        )
        return result.scalar_one_or_none()

    async def find_active_for_user(self, user_id: uuid.UUID) -> AttendanceSession | None:
        result = await self.db.execute(
            select(AttendanceSession)
            .where(
                AttendanceSession.user_id == user_id,
                AttendanceSession.status == AttendanceStatus.PUNCHED_IN,
            )
            .order_by(AttendanceSession.punched_in_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def find_active_for_user_for_update(
        self, user_id: uuid.UUID
    ) -> AttendanceSession | None:
        result = await self.db.execute(
            select(AttendanceSession)
            .where(
                AttendanceSession.user_id == user_id,
                AttendanceSession.status == AttendanceStatus.PUNCHED_IN,
            )
            .order_by(AttendanceSession.punched_in_at.desc())
            .limit(1)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def find_by_id(self, session_id: uuid.UUID) -> AttendanceSession | None:
        return await self.db.get(AttendanceSession, session_id)

    async def find_by_id_for_update(self, session_id: uuid.UUID) -> AttendanceSession | None:
        result = await self.db.execute(
            select(AttendanceSession)
            .where(AttendanceSession.id == session_id)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def create_session(self, session: AttendanceSession) -> AttendanceSession:
        self.db.add(session)
        await self.db.flush()
        return session

    async def create_ping(self, ping: LocationPing) -> LocationPing:
        self.db.add(ping)
        await self.db.flush()
        return ping

    async def create_pings(self, pings: list[LocationPing]) -> list[LocationPing]:
        """Bulk-insert trail points for offline catch-up during a long shift."""
        if not pings:
            return []
        self.db.add_all(pings)
        await self.db.flush()
        return pings

    async def count_pings_for_session(self, session_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(LocationPing)
            .where(LocationPing.attendance_session_id == session_id)
        )
        return int(result.scalar_one())

    async def latest_ping_captured_at(self, session_id: uuid.UUID) -> datetime | None:
        result = await self.db.execute(
            select(LocationPing.captured_at)
            .where(LocationPing.attendance_session_id == session_id)
            .order_by(LocationPing.captured_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_or_create_location_settings(self) -> LocationSettings:
        result = await self.db.execute(
            select(LocationSettings)
            .where(LocationSettings.singleton_key == LOCATION_SETTINGS_KEY)
            .with_for_update()
        )
        settings_row = result.scalar_one_or_none()
        if settings_row is not None:
            return settings_row

        settings_row = LocationSettings(
            singleton_key=LOCATION_SETTINGS_KEY,
            location_mode=LocationMode.CONTINUOUS,
        )
        self.db.add(settings_row)
        await self.db.flush()
        return settings_row

    async def get_location_settings_readonly(self) -> LocationSettings:
        """Read location mode without locking — used on the hot GPS ping path."""
        result = await self.db.execute(
            select(LocationSettings).where(
                LocationSettings.singleton_key == LOCATION_SETTINGS_KEY
            )
        )
        settings_row = result.scalar_one_or_none()
        if settings_row is not None:
            return settings_row
        return await self.get_or_create_location_settings()
