"""Create the first GPSS administrator without putting a password in shell history."""

import asyncio
from getpass import getpass

from app.core.database import AsyncSessionLocal
from app.models.user import UserRole
from app.modules.auth.schemas import CreateUserRequest
from app.modules.auth.service import AuthService


async def create_admin() -> None:
    employee_id = input("Administrator employee ID: ").strip().upper()
    employee_name = input("Administrator name: ").strip()
    email = input("Administrator email: ").strip().lower()
    password = getpass("Administrator password (12+ characters): ")

    async with AsyncSessionLocal() as db:
        service = AuthService(db)
        try:
            user = await service.create_user(
                CreateUserRequest(
                    employee_id=employee_id,
                    employee_name=employee_name,
                    email=email,
                    password=password,
                    role=UserRole.ADMIN,
                ),
                allow_admin_role=True,
            )
        except Exception:
            await db.rollback()
            raise
    print(f"Created administrator {user.employee_id}.")


if __name__ == "__main__":
    asyncio.run(create_admin())
