import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class AttendanceStatus(enum.StrEnum):
    PUNCHED_IN = "punched_in"
    PUNCHED_OUT = "punched_out"


class LocationMode(enum.StrEnum):
    CONTINUOUS = "continuous"
    SINGLE = "single"


class AttendanceSession(Base):
    __tablename__ = "attendance_sessions"
    __table_args__ = (
        Index(
            "uq_attendance_sessions_one_active_per_user",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'punched_in'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        "session_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.user_id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    status: Mapped[AttendanceStatus] = mapped_column(
        Enum(
            AttendanceStatus,
            name="attendance_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=AttendanceStatus.PUNCHED_IN,
    )
    opening_odo_km: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    opening_selfie_path: Mapped[str] = mapped_column(String(512), nullable=False)
    opening_odo_image_path: Mapped[str] = mapped_column(String(512), nullable=False)
    closing_odo_km: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    closing_odo_image_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    punch_in_latitude: Mapped[float] = mapped_column(Float, nullable=False)
    punch_in_longitude: Mapped[float] = mapped_column(Float, nullable=False)
    punch_in_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    punch_out_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    punch_out_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    punch_out_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    punched_in_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    punched_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="attendance_sessions")
    location_pings: Mapped[list["LocationPing"]] = relationship(
        back_populates="attendance_session", cascade="all, delete-orphan"
    )


class LocationPing(Base):
    __tablename__ = "location_pings"
    __table_args__ = (
        Index(
            "ix_location_pings_session_captured_at",
            "attendance_session_id",
            "captured_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        "ping_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    attendance_session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("attendance_sessions.session_id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    battery: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    attendance_session: Mapped["AttendanceSession"] = relationship(
        back_populates="location_pings"
    )


class LocationSettings(Base):
    """Singleton org setting for continuous vs single-location sharing."""

    __tablename__ = "location_settings"
    __table_args__ = (UniqueConstraint("singleton_key", name="uq_location_settings_singleton"),)

    id: Mapped[uuid.UUID] = mapped_column(
        "settings_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    singleton_key: Mapped[str] = mapped_column(String(32), nullable=False, default="default")
    location_mode: Mapped[LocationMode] = mapped_column(
        Enum(
            LocationMode,
            name="location_mode",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=LocationMode.CONTINUOUS,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
