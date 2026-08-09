"""attendance hardening: one active session per user

Revision ID: 20260809_0004
Revises: 20260809_0003
Create Date: 2026-08-09 19:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260809_0004"
down_revision: str | Sequence[str] | None = "20260809_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Close older duplicate active sessions so the unique index can be created.
    op.execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT
                    session_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY user_id
                        ORDER BY punched_in_at DESC, session_id DESC
                    ) AS rn
                FROM attendance_sessions
                WHERE status = 'punched_in'
            )
            UPDATE attendance_sessions AS sessions
            SET
                status = 'punched_out',
                punched_out_at = COALESCE(sessions.punched_out_at, NOW())
            FROM ranked
            WHERE sessions.session_id = ranked.session_id
              AND ranked.rn > 1
            """
        )
    )
    op.create_index(
        "uq_attendance_sessions_one_active_per_user",
        "attendance_sessions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'punched_in'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_attendance_sessions_one_active_per_user",
        table_name="attendance_sessions",
    )
