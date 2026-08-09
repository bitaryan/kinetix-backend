"""Local disk storage for punch verification images."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.config import get_settings
from app.core.errors import APIError

logger = logging.getLogger(__name__)

# Content-Type allow-list (client-declared). Actual type is verified via magic bytes.
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

_READ_CHUNK = 64 * 1024


def _extension_from_magic(payload: bytes) -> str | None:
    """Return a safe extension from file magic bytes, or None if not an image."""
    if len(payload) >= 3 and payload[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if len(payload) >= 8 and payload[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if (
        len(payload) >= 12
        and payload[:4] == b"RIFF"
        and payload[8:12] == b"WEBP"
    ):
        return ".webp"
    return None


async def _read_upload_capped(upload: UploadFile, *, max_bytes: int) -> bytes:
    """Read an upload in chunks and reject once it exceeds max_bytes."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise APIError(
                400,
                "IMAGE_TOO_LARGE",
                "Upload exceeds the maximum upload size",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def save_verification_image(
    *,
    upload: UploadFile,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    kind: str,
) -> str:
    """Persist an uploaded image and return its relative storage path."""
    settings = get_settings()
    content_type = (upload.content_type or "").lower().strip()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise APIError(
            400,
            "INVALID_IMAGE",
            f"{kind} must be a JPEG, PNG, or WebP image",
        )

    payload = await _read_upload_capped(upload, max_bytes=settings.max_upload_bytes)
    if not payload:
        raise APIError(400, "INVALID_IMAGE", f"{kind} file is empty")

    extension = _extension_from_magic(payload)
    if extension is None:
        raise APIError(
            400,
            "INVALID_IMAGE",
            f"{kind} must be a valid JPEG, PNG, or WebP image",
        )

    relative = Path("attendance") / str(user_id) / str(session_id) / f"{kind}{extension}"
    absolute = Path(settings.upload_dir) / relative
    absolute.parent.mkdir(parents=True, exist_ok=True)
    absolute.write_bytes(payload)
    return relative.as_posix()


def delete_stored_files(*relative_paths: str) -> None:
    """Best-effort cleanup of verification files after a failed punch transaction."""
    if not relative_paths:
        return
    settings = get_settings()
    root = Path(settings.upload_dir).resolve()
    for relative in relative_paths:
        if not relative:
            continue
        absolute = (Path(settings.upload_dir) / relative).resolve()
        try:
            if root not in absolute.parents and absolute != root:
                continue
            if absolute.is_file():
                absolute.unlink()
        except OSError:
            logger.warning("Failed to delete orphaned upload %s", absolute, exc_info=True)
