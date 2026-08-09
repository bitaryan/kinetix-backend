"""Minimal security response headers for production hardening."""

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class SecurityHeadersMiddleware:
    """Pure ASGI middleware — avoids BaseHTTPMiddleware event-loop issues."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("X-Frame-Options", "DENY")
                headers.setdefault("Referrer-Policy", "no-referrer")
                headers.setdefault(
                    "Permissions-Policy", "geolocation=(), microphone=(), camera=()"
                )
                headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
                headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
            await send(message)

        await self.app(scope, receive, send_with_headers)
