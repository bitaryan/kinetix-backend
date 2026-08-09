from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, status
from pydantic import ValidationError

from app.core.errors import APIError
from app.core.rate_limit import enforce_location_ping_rate_limit
from app.models.attendance import AttendanceSession, AttendanceStatus, LocationMode
from app.models.user import UserRole
from app.modules.attendance.schemas import (
    CurrentSessionData,
    LocationPingBatchData,
    LocationPingBatchItemData,
    LocationPingBatchRequest,
    LocationPingData,
    LocationPingRequest,
    LocationSettingsData,
    LocationSettingsUpdate,
    PunchInForm,
    PunchOutData,
    PunchOutForm,
    PunchSessionData,
)
from app.modules.attendance.service import AttendanceService
from app.modules.auth.dependencies import (
    CurrentPrincipal,
    DbSession,
    get_current_principal,
    require_roles,
)
from app.modules.auth.schemas import SuccessResponse

router = APIRouter(prefix="/attendance", tags=["Attendance"])
admin_router = APIRouter(prefix="/admin", tags=["Admin"])

# Field staff punch; admins manage location mode only.
_AttendancePrincipal = Annotated[
    CurrentPrincipal,
    Depends(require_roles(UserRole.EMPLOYEE, UserRole.MANAGER)),
]


def _session_data(
    session: AttendanceSession, *, location_mode: LocationMode
) -> PunchSessionData:
    return PunchSessionData(
        session_id=session.id,
        status=session.status,
        punched_in_at=session.punched_in_at,
        punched_out_at=session.punched_out_at,
        opening_odo_km=session.opening_odo_km,
        closing_odo_km=session.closing_odo_km,
        latitude=session.punch_in_latitude,
        longitude=session.punch_in_longitude,
        location_mode=location_mode,
    )


def _parse_optional_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError as exc:
        raise APIError(422, "VALIDATION_ERROR", "Request data is invalid") from exc


def _parse_optional_datetime(value: str | None) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise APIError(422, "VALIDATION_ERROR", "Request data is invalid") from exc
    if parsed.tzinfo is None:
        raise APIError(
            422,
            "VALIDATION_ERROR",
            "capturedAt must include a timezone offset",
        )
    return parsed


def _punch_in_form(**kwargs: object) -> PunchInForm:
    try:
        return PunchInForm.model_validate(kwargs)
    except ValidationError as exc:
        raise APIError(422, "VALIDATION_ERROR", "Request data is invalid") from exc


def _punch_out_form(**kwargs: object) -> PunchOutForm:
    try:
        return PunchOutForm.model_validate(kwargs)
    except ValidationError as exc:
        raise APIError(422, "VALIDATION_ERROR", "Request data is invalid") from exc


@router.post(
    "/punch-in",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[PunchSessionData],
)
async def punch_in(
    db: DbSession,
    principal: _AttendancePrincipal,
    selfie: Annotated[UploadFile, File(description="Employee selfie")],
    opening_odo_image: Annotated[
        UploadFile, File(alias="openingOdoImage", description="Opening odometer photo")
    ],
    opening_odo_km: Annotated[Decimal, Form(alias="openingOdoKm")],
    latitude: Annotated[float, Form()],
    longitude: Annotated[float, Form()],
    accuracy: Annotated[str | None, Form()] = None,
    captured_at: Annotated[str | None, Form(alias="capturedAt")] = None,
) -> SuccessResponse[PunchSessionData]:
    """Record punch-in with verification media and the first location point."""
    form = _punch_in_form(
        opening_odo_km=opening_odo_km,
        latitude=latitude,
        longitude=longitude,
        accuracy=_parse_optional_float(accuracy),
        captured_at=_parse_optional_datetime(captured_at),
    )
    result = await AttendanceService(db).punch_in(
        user_id=principal.user.id,
        form=form,
        selfie=selfie,
        opening_odo_image=opening_odo_image,
    )
    return SuccessResponse(
        data=_session_data(result.session, location_mode=result.location_mode)
    )


@router.get("/current", response_model=SuccessResponse[CurrentSessionData])
async def current_session(
    db: DbSession,
    principal: _AttendancePrincipal,
) -> SuccessResponse[CurrentSessionData]:
    """Return the active punched-in session so the app can restore location sharing."""
    session, location_mode = await AttendanceService(db).get_current(principal.user.id)
    if session is None:
        return SuccessResponse(
            data=CurrentSessionData(
                punched_in=False,
                session=None,
                location_mode=location_mode,
            )
        )
    return SuccessResponse(
        data=CurrentSessionData(
            punched_in=True,
            session=_session_data(session, location_mode=location_mode),
            location_mode=location_mode,
        )
    )


@router.post("/location-ping", response_model=SuccessResponse[LocationPingData])
async def location_ping(
    payload: LocationPingRequest,
    request: Request,
    db: DbSession,
    principal: _AttendancePrincipal,
) -> SuccessResponse[LocationPingData]:
    """Append a GPS ping to the active attendance session trail."""
    enforce_location_ping_rate_limit(request, user_id=principal.user.id, cost=1)
    result = await AttendanceService(db).location_ping(
        user_id=principal.user.id, payload=payload
    )
    return SuccessResponse(
        data=LocationPingData(
            accepted=result.accepted,
            reason=result.reason,
            ping_id=result.ping.id if result.ping is not None else None,
            location_mode=result.location_mode,
        )
    )


@router.post("/location-pings", response_model=SuccessResponse[LocationPingBatchData])
async def location_ping_batch(
    payload: LocationPingBatchRequest,
    request: Request,
    db: DbSession,
    principal: _AttendancePrincipal,
) -> SuccessResponse[LocationPingBatchData]:
    """Flush a queued offline GPS trail in one request (supports long shifts)."""
    enforce_location_ping_rate_limit(
        request, user_id=principal.user.id, cost=len(payload.pings)
    )
    result = await AttendanceService(db).location_ping_batch(
        user_id=principal.user.id, payload=payload
    )
    return SuccessResponse(
        data=LocationPingBatchData(
            accepted_count=result.accepted_count,
            rejected_count=result.rejected_count,
            location_mode=result.location_mode,
            items=[
                LocationPingBatchItemData(
                    index=item.index,
                    accepted=item.accepted,
                    reason=item.reason,
                    ping_id=item.ping_id,
                )
                for item in result.items
            ],
        )
    )


@router.post("/punch-out", response_model=SuccessResponse[PunchOutData])
async def punch_out(
    db: DbSession,
    principal: _AttendancePrincipal,
    closing_odo_image: Annotated[
        UploadFile, File(alias="closingOdoImage", description="Closing odometer photo")
    ],
    closing_odo_km: Annotated[Decimal, Form(alias="closingOdoKm")],
    latitude: Annotated[float, Form()],
    longitude: Annotated[float, Form()],
    accuracy: Annotated[str | None, Form()] = None,
    captured_at: Annotated[str | None, Form(alias="capturedAt")] = None,
) -> SuccessResponse[PunchOutData]:
    """Close the active session and stop accepting further location pings."""
    form = _punch_out_form(
        closing_odo_km=closing_odo_km,
        latitude=latitude,
        longitude=longitude,
        accuracy=_parse_optional_float(accuracy),
        captured_at=_parse_optional_datetime(captured_at),
    )
    session = await AttendanceService(db).punch_out(
        user_id=principal.user.id,
        form=form,
        closing_odo_image=closing_odo_image,
    )
    punched_out_at = session.punched_out_at
    if punched_out_at is None:
        raise APIError(500, "INTERNAL_ERROR", "Punch-out completed without a timestamp")
    return SuccessResponse(
        data=PunchOutData(
            session_id=session.id,
            status=AttendanceStatus.PUNCHED_OUT,
            punched_in_at=session.punched_in_at,
            punched_out_at=punched_out_at,
        )
    )


@admin_router.get("/location-settings", response_model=SuccessResponse[LocationSettingsData])
async def get_location_settings(
    db: DbSession,
    _: Annotated[CurrentPrincipal, Depends(require_roles(UserRole.ADMIN))],
) -> SuccessResponse[LocationSettingsData]:
    mode = await AttendanceService(db).get_location_mode()
    return SuccessResponse(data=LocationSettingsData(location_mode=mode))


@admin_router.patch("/location-settings", response_model=SuccessResponse[LocationSettingsData])
async def update_location_settings(
    payload: LocationSettingsUpdate,
    db: DbSession,
    _: Annotated[CurrentPrincipal, Depends(require_roles(UserRole.ADMIN))],
) -> SuccessResponse[LocationSettingsData]:
    """Set continuous trail vs single-location mode (admin)."""
    mode = await AttendanceService(db).update_location_mode(payload.location_mode)
    return SuccessResponse(data=LocationSettingsData(location_mode=mode))
