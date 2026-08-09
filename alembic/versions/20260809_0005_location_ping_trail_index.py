"""location pings: trail index for sustained 8h shifts

Revision ID: 20260809_0005
Revises: 20260809_0004
Create Date: 2026-08-09 19:30:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260809_0005"
down_revision: str | Sequence[str] | None = "20260809_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Hot path for last-ping / trail reads during an 8-hour continuous shift.
    op.create_index(
        "ix_location_pings_session_captured_at",
        "location_pings",
        ["attendance_session_id", "captured_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_location_pings_session_captured_at", table_name="location_pings")
