from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.attendance import AttendanceStatus, LocationMode


def _require_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("datetime must include a timezone offset")
    return value.astimezone(UTC)


class PunchInForm(BaseModel):
    """Validated form fields for multipart punch-in."""

    model_config = ConfigDict(populate_by_name=True)

    opening_odo_km: Decimal = Field(alias="openingOdoKm", ge=0, le=Decimal("9999999.99"))
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)
    captured_at: datetime | None = Field(default=None, alias="capturedAt")

    @field_validator("opening_odo_km")
    @classmethod
    def quantize_odo(cls, value: Decimal) -> Decimal:
        return value.quantize(Decimal("0.01"))

    @field_validator("captured_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return _require_aware_utc(value)


class LocationPingPoint(BaseModel):
    """One GPS sample (used by single and batch trail endpoints)."""

    model_config = ConfigDict(populate_by_name=True)

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)
    # Naive values are allowed so the service can soft-fail with INVALID_TIMESTAMP.
    captured_at: datetime = Field(alias="capturedAt")
    battery: float | None = Field(default=None, ge=0, le=100)
    speed: float | None = Field(default=None, ge=0)

    @field_validator("captured_at")
    @classmethod
    def normalize_aware_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value
        return value.astimezone(UTC)


class LocationPingRequest(LocationPingPoint):
    model_config = ConfigDict(populate_by_name=True)

    session_id: UUID = Field(alias="sessionId")


class LocationPingBatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: UUID = Field(alias="sessionId")
    pings: list[LocationPingPoint] = Field(min_length=1)

    @field_validator("pings")
    @classmethod
    def enforce_batch_cap(cls, value: list[LocationPingPoint]) -> list[LocationPingPoint]:
        from app.core.config import get_settings

        max_batch = get_settings().location_ping_batch_max
        if len(value) > max_batch:
            raise ValueError(f"At most {max_batch} pings are allowed per batch")
        return value


class PunchOutForm(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    closing_odo_km: Decimal = Field(alias="closingOdoKm", ge=0, le=Decimal("9999999.99"))
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)
    captured_at: datetime | None = Field(default=None, alias="capturedAt")

    @field_validator("closing_odo_km")
    @classmethod
    def quantize_odo(cls, value: Decimal) -> Decimal:
        return value.quantize(Decimal("0.01"))

    @field_validator("captured_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return _require_aware_utc(value)


class LocationSettingsUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    location_mode: LocationMode = Field(alias="locationMode")


class PunchSessionData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: UUID = Field(alias="sessionId")
    status: AttendanceStatus
    punched_in_at: datetime = Field(alias="punchedInAt")
    punched_out_at: datetime | None = Field(default=None, alias="punchedOutAt")
    opening_odo_km: Decimal = Field(alias="openingOdoKm")
    closing_odo_km: Decimal | None = Field(default=None, alias="closingOdoKm")
    latitude: float
    longitude: float
    location_mode: LocationMode = Field(alias="locationMode")


class CurrentSessionData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    punched_in: bool = Field(alias="punchedIn")
    session: PunchSessionData | None = None
    location_mode: LocationMode = Field(alias="locationMode")


class LocationPingData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    reason: str | None = None
    ping_id: UUID | None = Field(default=None, alias="pingId")
    location_mode: LocationMode = Field(alias="locationMode")


class LocationPingBatchItemData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    index: int
    accepted: bool
    reason: str | None = None
    ping_id: UUID | None = Field(default=None, alias="pingId")


class LocationPingBatchData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    accepted_count: int = Field(alias="acceptedCount")
    rejected_count: int = Field(alias="rejectedCount")
    location_mode: LocationMode = Field(alias="locationMode")
    items: list[LocationPingBatchItemData]


class LocationSettingsData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    location_mode: LocationMode = Field(alias="locationMode")


class PunchOutData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: UUID = Field(alias="sessionId")
    status: AttendanceStatus = AttendanceStatus.PUNCHED_OUT
    punched_in_at: datetime = Field(alias="punchedInAt")
    punched_out_at: datetime = Field(alias="punchedOutAt")
