"""add previous_refresh_token_hash for reuse detection

Revision ID: 20260808_0002
Revises: 20260808_0001
Create Date: 2026-08-08 18:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260808_0002"
down_revision: str | Sequence[str] | None = "20260808_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "active_sessions",
        sa.Column("previous_refresh_token_hash", sa.String(length=64), nullable=True),
    )
    op.create_unique_constraint(
        "uq_active_sessions_previous_refresh_token_hash",
        "active_sessions",
        ["previous_refresh_token_hash"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_active_sessions_previous_refresh_token_hash",
        "active_sessions",
        type_="unique",
    )
    op.drop_column("active_sessions", "previous_refresh_token_hash")
