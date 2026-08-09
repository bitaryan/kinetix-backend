from dataclasses import dataclass


@dataclass(slots=True)
class APIError(Exception):
    """Known application failure that is safe to return to an API client."""

    status_code: int
    code: str
    message: str
