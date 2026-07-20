import secrets
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from app.core.config import Settings


async def require_internal_api_key(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
    settings: Settings,
) -> Response:
    request.state.internal_api_key_authenticated = False
    if not settings.internal_api_key or request.method == "OPTIONS":
        return await call_next(request)
    if _is_exempt(request.url.path, settings.auth_exempt_paths):
        return await call_next(request)
    if _credential_matches(request, settings.internal_api_key):
        request.state.internal_api_key_authenticated = True
        return await call_next(request)
    return await call_next(request)


def _is_exempt(path: str, exempt_paths: list[str]) -> bool:
    return any(path == exempt or path.startswith(f"{exempt}/") for exempt in exempt_paths)


def _credential_matches(request: Request, expected: str) -> bool:
    candidates = [
        request.headers.get("x-api-key"),
        _bearer_token(request.headers.get("authorization")),
        request.query_params.get("api_key"),
    ]
    return any(candidate is not None and secrets.compare_digest(candidate, expected) for candidate in candidates)


def _bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token
