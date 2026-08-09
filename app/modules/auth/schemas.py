from datetime import datetime
from typing import Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole

T = TypeVar("T")


class SuccessResponse(BaseModel, Generic[T]):
    success: Literal[True] = True
    data: T
    error: None = None


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    success: Literal[False] = False
    data: None = None
    error: ErrorDetail


def _require_password_complexity(value: str) -> str:
    has_lower = any(char.islower() for char in value)
    has_upper = any(char.isupper() for char in value)
    has_digit = any(char.isdigit() for char in value)
    if not (has_lower and has_upper and has_digit):
        raise ValueError(
            "Password must include uppercase, lowercase, and a digit"
        )
    return value


class LoginRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    employee_id: str = Field(min_length=1, max_length=30, alias="userId")
    password: str = Field(min_length=8, max_length=128)
    role: UserRole

    @field_validator("employee_id")
    @classmethod
    def normalize_employee_id(cls, value: str) -> str:
        return value.strip().upper()


class CreateUserRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    employee_id: str = Field(min_length=1, max_length=30, alias="userId")
    employee_name: str = Field(min_length=1, max_length=100, alias="employeeName")
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    role: UserRole = UserRole.EMPLOYEE

    @field_validator("employee_id")
    @classmethod
    def normalize_employee_id(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).lower()

    @field_validator("password")
    @classmethod
    def enforce_password_complexity(cls, value: str) -> str:
        return _require_password_complexity(value)


class UserProfile(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: UUID
    employee_id: str = Field(alias="userId")
    employee_name: str = Field(alias="employeeName")
    email: EmailStr
    role: UserRole
    is_active: bool = Field(alias="isActive")
    created_at: datetime = Field(alias="createdAt")


class LoginData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    access_token: str = Field(alias="accessToken")
    token_type: Literal["bearer"] = Field(default="bearer", alias="tokenType")
    expires_in: int = Field(alias="expiresIn")
    user: UserProfile


class AccessTokenData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    access_token: str = Field(alias="accessToken")
    token_type: Literal["bearer"] = Field(default="bearer", alias="tokenType")
    expires_in: int = Field(alias="expiresIn")


class MessageData(BaseModel):
    message: str
