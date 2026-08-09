"""create attendance and location tables

Revision ID: 20260809_0003
Revises: 20260808_0002
Create Date: 2026-08-09 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260809_0003"
down_revision: str | Sequence[str] | None = "20260808_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

attendance_status = postgresql.ENUM(
    "punched_in",
    "punched_out",
    name="attendance_status",
    create_type=False,
)
location_mode = postgresql.ENUM(
    "continuous",
    "single",
    name="location_mode",
    create_type=False,
)


def upgrade() -> None:
    attendance_status.create(op.get_bind(), checkfirst=True)
    location_mode.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "attendance_sessions",
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", attendance_status, nullable=False),
        sa.Column("opening_odo_km", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("opening_selfie_path", sa.String(length=512), nullable=False),
        sa.Column("opening_odo_image_path", sa.String(length=512), nullable=False),
        sa.Column("closing_odo_km", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("closing_odo_image_path", sa.String(length=512), nullable=True),
        sa.Column("punch_in_latitude", sa.Float(), nullable=False),
        sa.Column("punch_in_longitude", sa.Float(), nullable=False),
        sa.Column("punch_in_accuracy", sa.Float(), nullable=True),
        sa.Column("punch_out_latitude", sa.Float(), nullable=True),
        sa.Column("punch_out_longitude", sa.Float(), nullable=True),
        sa.Column("punch_out_accuracy", sa.Float(), nullable=True),
        sa.Column("punched_in_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("punched_out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.user_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id"),
    )
    op.create_index(
        "ix_attendance_sessions_user_id", "attendance_sessions", ["user_id"], unique=False
    )
    op.create_index(
        "ix_attendance_sessions_user_status",
        "attendance_sessions",
        ["user_id", "status"],
        unique=False,
    )

    op.create_table(
        "location_pings",
        sa.Column("ping_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("attendance_session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("accuracy", sa.Float(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("battery", sa.Float(), nullable=True),
        sa.Column("speed", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["attendance_session_id"],
            ["attendance_sessions.session_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("ping_id"),
    )
    op.create_index(
        "ix_location_pings_attendance_session_id",
        "location_pings",
        ["attendance_session_id"],
        unique=False,
    )

    op.create_table(
        "location_settings",
        sa.Column("settings_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("singleton_key", sa.String(length=32), nullable=False),
        sa.Column("location_mode", location_mode, nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("settings_id"),
        sa.UniqueConstraint("singleton_key", name="uq_location_settings_singleton"),
    )
    op.execute(
        sa.text(
            "INSERT INTO location_settings (settings_id, singleton_key, location_mode) "
            "VALUES (gen_random_uuid(), 'default', 'continuous')"
        )
    )


def downgrade() -> None:
    op.drop_table("location_settings")
    op.drop_index("ix_location_pings_attendance_session_id", table_name="location_pings")
    op.drop_table("location_pings")
    op.drop_index("ix_attendance_sessions_user_status", table_name="attendance_sessions")
    op.drop_index("ix_attendance_sessions_user_id", table_name="attendance_sessions")
    op.drop_table("attendance_sessions")
    location_mode.drop(op.get_bind(), checkfirst=True)
    attendance_status.drop(op.get_bind(), checkfirst=True)
