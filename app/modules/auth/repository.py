import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import ActiveSession
from app.models.user import User


class UserRepository:
    """ORM-only persistence operations for users."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def find_by_employee_id(self, employee_id: str) -> User | None:
        result = await self.db.execute(select(User).where(User.employee_id == employee_id))
        return result.scalar_one_or_none()

    async def find_by_employee_id_for_update(self, employee_id: str) -> User | None:
        result = await self.db.execute(
            select(User).where(User.employee_id == employee_id).with_for_update()
        )
        return result.scalar_one_or_none()

    async def find_by_email(self, email: str) -> User | None:
        result = await self.db.execute(select(User).where(User.email == email))
        return result.scalar_one_or_none()

    async def find_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self.db.get(User, user_id)

    async def create(self, user: User) -> User:
        self.db.add(user)
        await self.db.flush()
        return user


class ActiveSessionRepository:
    """ORM-only persistence operations for refresh-token sessions."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(self, active_session: ActiveSession) -> ActiveSession:
        self.db.add(active_session)
        await self.db.flush()
        return active_session

    async def find_by_id(self, session_id: uuid.UUID) -> ActiveSession | None:
        return await self.db.get(ActiveSession, session_id)

    async def find_by_refresh_hash_for_update(
        self, refresh_token_hash: str
    ) -> ActiveSession | None:
        result = await self.db.execute(
            select(ActiveSession)
            .where(ActiveSession.refresh_token_hash == refresh_token_hash)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def find_by_previous_refresh_hash_for_update(
        self, refresh_token_hash: str
    ) -> ActiveSession | None:
        result = await self.db.execute(
            select(ActiveSession)
            .where(ActiveSession.previous_refresh_token_hash == refresh_token_hash)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def revoke_for_user(self, user_id: uuid.UUID) -> None:
        await self.db.execute(
            update(ActiveSession)
            .where(ActiveSession.user_id == user_id, ActiveSession.is_revoked.is_(False))
            .values(is_revoked=True)
        )
