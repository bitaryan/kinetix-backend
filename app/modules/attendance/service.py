import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import APIError
from app.core.security import utc_now
from app.models.attendance import (
    AttendanceSession,
    AttendanceStatus,
    LocationMode,
    LocationPing,
)
from app.modules.attendance import location_mode_cache
from app.modules.attendance.repository import AttendanceRepository
from app.modules.attendance.schemas import (
    LocationPingBatchRequest,
    LocationPingPoint,
    LocationPingRequest,
    PunchInForm,
    PunchOutForm,
)
from app.modules.attendance.storage import delete_stored_files, save_verification_image

# Soft-ignore device clocks more than 24h ahead/behind server time.
_MAX_CLOCK_SKEW = timedelta(hours=24)


@dataclass(frozen=True, slots=True)
class PunchInResult:
    session: AttendanceSession
    location_mode: LocationMode


@dataclass(frozen=True, slots=True)
class LocationPingResult:
    accepted: bool
    reason: str | None
    ping: LocationPing | None
    location_mode: LocationMode


@dataclass(frozen=True, slots=True)
class LocationPingBatchItemResult:
    index: int
    accepted: bool
    reason: str | None
    ping_id: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class LocationPingBatchResult:
    accepted_count: int
    rejected_count: int
    location_mode: LocationMode
    items: list[LocationPingBatchItemResult]


def _ensure_aware_utc(value: datetime) -> datetime | None:
    """Return timezone-aware UTC datetime, or None when the value is naive."""
    if value.tzinfo is None:
        return None
    return value.astimezone(UTC)


def _is_stale(captured_at: datetime, *, now: datetime) -> bool:
    return abs(captured_at - now) > _MAX_CLOCK_SKEW


class AttendanceService:
    """Punch-in / location trail business rules."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.attendance = AttendanceRepository(db)

    async def _resolve_location_mode(self) -> LocationMode:
        cached = location_mode_cache.get_cached_location_mode()
        if cached is not None:
            return cached
        settings = await self.attendance.get_location_settings_readonly()
        location_mode_cache.set_cached_location_mode(settings.location_mode)
        return settings.location_mode

    async def get_current(
        self, user_id: uuid.UUID
    ) -> tuple[AttendanceSession | None, LocationMode]:
        location_mode = await self._resolve_location_mode()
        active = await self.attendance.find_active_for_user(user_id)
        return active, location_mode

    async def punch_in(
        self,
        *,
        user_id: uuid.UUID,
        form: PunchInForm,
        selfie: UploadFile,
        opening_odo_image: UploadFile,
    ) -> PunchInResult:
        # Lock the user row so concurrent punch-ins serialize even with no session yet.
        locked_user = await self.attendance.lock_user(user_id)
        if locked_user is None:
            raise APIError(401, "UNAUTHORIZED", "User account is unavailable")

        existing = await self.attendance.find_active_for_user_for_update(user_id)
        if existing is not None:
            raise APIError(
                409,
                "ALREADY_PUNCHED_IN",
                "An active punch-in session already exists",
            )

        location_mode = await self._resolve_location_mode()
        now = utc_now()
        if form.captured_at is not None:
            captured_at = _ensure_aware_utc(form.captured_at)
            if captured_at is None:
                raise APIError(
                    422,
                    "VALIDATION_ERROR",
                    "capturedAt must include a timezone offset",
                )
            if _is_stale(captured_at, now=now):
                raise APIError(
                    400,
                    "STALE_TIMESTAMP",
                    "capturedAt is too far from server time",
                )
        else:
            captured_at = now

        session_id = uuid.uuid4()
        saved_paths: list[str] = []
        try:
            selfie_path = await save_verification_image(
                upload=selfie,
                user_id=user_id,
                session_id=session_id,
                kind="selfie",
            )
            saved_paths.append(selfie_path)
            odo_path = await save_verification_image(
                upload=opening_odo_image,
                user_id=user_id,
                session_id=session_id,
                kind="opening_odo",
            )
            saved_paths.append(odo_path)

            session = AttendanceSession(
                id=session_id,
                user_id=user_id,
                status=AttendanceStatus.PUNCHED_IN,
                opening_odo_km=form.opening_odo_km,
                opening_selfie_path=selfie_path,
                opening_odo_image_path=odo_path,
                punch_in_latitude=form.latitude,
                punch_in_longitude=form.longitude,
                punch_in_accuracy=form.accuracy,
                punched_in_at=now,
            )
            await self.attendance.create_session(session)
            await self.attendance.create_ping(
                LocationPing(
                    attendance_session_id=session.id,
                    latitude=form.latitude,
                    longitude=form.longitude,
                    accuracy=form.accuracy,
                    captured_at=captured_at,
                )
            )
            await self.db.commit()
        except IntegrityError as exc:
            await self.db.rollback()
            delete_stored_files(*saved_paths)
            raise APIError(
                409,
                "ALREADY_PUNCHED_IN",
                "An active punch-in session already exists",
            ) from exc
        except Exception:
            await self.db.rollback()
            delete_stored_files(*saved_paths)
            raise

        await self.db.refresh(session)
        return PunchInResult(session=session, location_mode=location_mode)

    async def _validate_ping_point(
        self,
        *,
        point: LocationPingPoint,
        now: datetime,
        last_captured_at: datetime | None,
        remaining_capacity: int,
        min_interval_seconds: float,
    ) -> tuple[str | None, datetime | None]:
        """Return (reject_reason, aware_captured_at)."""
        if remaining_capacity <= 0:
            return "SESSION_TRAIL_FULL", None

        captured_at = _ensure_aware_utc(point.captured_at)
        if captured_at is None:
            return "INVALID_TIMESTAMP", None
        if _is_stale(captured_at, now=now):
            return "STALE_PING", None
        if (
            last_captured_at is not None
            and min_interval_seconds > 0
            and (captured_at - last_captured_at).total_seconds() < min_interval_seconds
        ):
            return "TOO_FREQUENT", None
        return None, captured_at

    async def location_ping(
        self, *, user_id: uuid.UUID, payload: LocationPingRequest
    ) -> LocationPingResult:
        """Append one GPS sample. Optimized for 8h continuous trails (no row locks)."""
        location_mode = await self._resolve_location_mode()
        session = await self.attendance.find_by_id(payload.session_id)

        if session is None or session.user_id != user_id:
            return LocationPingResult(
                accepted=False,
                reason="SESSION_NOT_FOUND",
                ping=None,
                location_mode=location_mode,
            )
        if session.status != AttendanceStatus.PUNCHED_IN:
            return LocationPingResult(
                accepted=False,
                reason="SESSION_NOT_ACTIVE",
                ping=None,
                location_mode=location_mode,
            )
        if location_mode == LocationMode.SINGLE:
            return LocationPingResult(
                accepted=False,
                reason="SINGLE_LOCATION_MODE",
                ping=None,
                location_mode=location_mode,
            )

        settings = get_settings()
        ping_count = await self.attendance.count_pings_for_session(session.id)
        remaining = settings.location_ping_max_per_session - ping_count
        last_captured = await self.attendance.latest_ping_captured_at(session.id)
        now = utc_now()
        reason, captured_at = await self._validate_ping_point(
            point=LocationPingPoint(
                latitude=payload.latitude,
                longitude=payload.longitude,
                accuracy=payload.accuracy,
                captured_at=payload.captured_at,
                battery=payload.battery,
                speed=payload.speed,
            ),
            now=now,
            last_captured_at=last_captured,
            remaining_capacity=remaining,
            min_interval_seconds=settings.location_ping_min_interval_seconds,
        )
        if reason is not None or captured_at is None:
            return LocationPingResult(
                accepted=False,
                reason=reason,
                ping=None,
                location_mode=location_mode,
            )

        ping = await self.attendance.create_ping(
            LocationPing(
                attendance_session_id=session.id,
                latitude=payload.latitude,
                longitude=payload.longitude,
                accuracy=payload.accuracy,
                captured_at=captured_at,
                battery=payload.battery,
                speed=payload.speed,
            )
        )
        await self.db.commit()
        return LocationPingResult(
            accepted=True,
            reason=None,
            ping=ping,
            location_mode=location_mode,
        )

    async def location_ping_batch(
        self, *, user_id: uuid.UUID, payload: LocationPingBatchRequest
    ) -> LocationPingBatchResult:
        """Flush a queued offline trail (up to ~1h of 30s samples) in one round-trip."""
        location_mode = await self._resolve_location_mode()
        session = await self.attendance.find_by_id(payload.session_id)
        settings = get_settings()

        if session is None or session.user_id != user_id:
            return LocationPingBatchResult(
                accepted_count=0,
                rejected_count=len(payload.pings),
                location_mode=location_mode,
                items=[
                    LocationPingBatchItemResult(
                        index=i, accepted=False, reason="SESSION_NOT_FOUND", ping_id=None
                    )
                    for i in range(len(payload.pings))
                ],
            )
        if session.status != AttendanceStatus.PUNCHED_IN:
            return LocationPingBatchResult(
                accepted_count=0,
                rejected_count=len(payload.pings),
                location_mode=location_mode,
                items=[
                    LocationPingBatchItemResult(
                        index=i, accepted=False, reason="SESSION_NOT_ACTIVE", ping_id=None
                    )
                    for i in range(len(payload.pings))
                ],
            )
        if location_mode == LocationMode.SINGLE:
            return LocationPingBatchResult(
                accepted_count=0,
                rejected_count=len(payload.pings),
                location_mode=location_mode,
                items=[
                    LocationPingBatchItemResult(
                        index=i,
                        accepted=False,
                        reason="SINGLE_LOCATION_MODE",
                        ping_id=None,
                    )
                    for i in range(len(payload.pings))
                ],
            )

        now = utc_now()
        ping_count = await self.attendance.count_pings_for_session(session.id)
        remaining = settings.location_ping_max_per_session - ping_count
        last_captured = await self.attendance.latest_ping_captured_at(session.id)
        min_interval = settings.location_ping_min_interval_seconds

        # Process in captured_at order so spacing rules stay correct for offline queues.
        ordered: list[tuple[int, LocationPingPoint]] = sorted(
            enumerate(payload.pings),
            key=lambda item: (
                item[1].captured_at.timestamp()
                if item[1].captured_at.tzinfo is not None
                else float("-inf")
            ),
        )

        items_by_index: dict[int, LocationPingBatchItemResult] = {}
        to_insert: list[LocationPing] = []

        for index, point in ordered:
            reason, captured_at = await self._validate_ping_point(
                point=point,
                now=now,
                last_captured_at=last_captured,
                remaining_capacity=remaining,
                min_interval_seconds=min_interval,
            )
            if reason is not None or captured_at is None:
                items_by_index[index] = LocationPingBatchItemResult(
                    index=index, accepted=False, reason=reason, ping_id=None
                )
                continue

            ping_id = uuid.uuid4()
            ping = LocationPing(
                id=ping_id,
                attendance_session_id=session.id,
                latitude=point.latitude,
                longitude=point.longitude,
                accuracy=point.accuracy,
                captured_at=captured_at,
                battery=point.battery,
                speed=point.speed,
            )
            to_insert.append(ping)
            items_by_index[index] = LocationPingBatchItemResult(
                index=index, accepted=True, reason=None, ping_id=ping_id
            )
            last_captured = captured_at
            remaining -= 1

        if to_insert:
            await self.attendance.create_pings(to_insert)
            await self.db.commit()

        items = [items_by_index[i] for i in range(len(payload.pings))]
        accepted_count = sum(1 for item in items if item.accepted)
        return LocationPingBatchResult(
            accepted_count=accepted_count,
            rejected_count=len(items) - accepted_count,
            location_mode=location_mode,
            items=items,
        )

    async def punch_out(
        self,
        *,
        user_id: uuid.UUID,
        form: PunchOutForm,
        closing_odo_image: UploadFile,
    ) -> AttendanceSession:
        locked_user = await self.attendance.lock_user(user_id)
        if locked_user is None:
            raise APIError(401, "UNAUTHORIZED", "User account is unavailable")

        session = await self.attendance.find_active_for_user_for_update(user_id)
        if session is None:
            raise APIError(409, "NOT_PUNCHED_IN", "No active punch-in session to close")

        if form.closing_odo_km < session.opening_odo_km:
            raise APIError(
                400,
                "INVALID_ODO_READING",
                "Closing odometer must be greater than or equal to opening odometer",
            )

        now = utc_now()
        if form.captured_at is not None:
            captured_at = _ensure_aware_utc(form.captured_at)
            if captured_at is None:
                raise APIError(
                    422,
                    "VALIDATION_ERROR",
                    "capturedAt must include a timezone offset",
                )
            if _is_stale(captured_at, now=now):
                raise APIError(
                    400,
                    "STALE_TIMESTAMP",
                    "capturedAt is too far from server time",
                )
        else:
            captured_at = now

        saved_paths: list[str] = []
        try:
            odo_path = await save_verification_image(
                upload=closing_odo_image,
                user_id=user_id,
                session_id=session.id,
                kind="closing_odo",
            )
            saved_paths.append(odo_path)
            session.status = AttendanceStatus.PUNCHED_OUT
            session.closing_odo_km = form.closing_odo_km
            session.closing_odo_image_path = odo_path
            session.punch_out_latitude = form.latitude
            session.punch_out_longitude = form.longitude
            session.punch_out_accuracy = form.accuracy
            session.punched_out_at = now

            location_mode = await self._resolve_location_mode()
            if location_mode == LocationMode.CONTINUOUS:
                await self.attendance.create_ping(
                    LocationPing(
                        attendance_session_id=session.id,
                        latitude=form.latitude,
                        longitude=form.longitude,
                        accuracy=form.accuracy,
                        captured_at=captured_at,
                    )
                )

            await self.db.commit()
        except Exception:
            await self.db.rollback()
            delete_stored_files(*saved_paths)
            raise

        await self.db.refresh(session)
        return session

    async def update_location_mode(self, mode: LocationMode) -> LocationMode:
        settings = await self.attendance.get_or_create_location_settings()
        settings.location_mode = mode
        await self.db.commit()
        location_mode_cache.set_cached_location_mode(mode)
        return settings.location_mode

    async def get_location_mode(self) -> LocationMode:
        return await self._resolve_location_mode()
