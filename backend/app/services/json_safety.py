import math
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any

_DROP = object()


def sanitize_json_payload(value: Any) -> Any:
    safe = _sanitize_value(value)
    return None if safe is _DROP else safe


def sanitize_json_dict(value: Mapping[str, Any] | None) -> dict[str, Any]:
    safe = _sanitize_value(value or {})
    return safe if isinstance(safe, dict) else {}


def _sanitize_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else _DROP
    if isinstance(value, Decimal):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else _DROP
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        safe: dict[str, Any] = {}
        for key, item in value.items():
            sanitized = _sanitize_value(item)
            if sanitized is not _DROP:
                safe[str(key)] = sanitized
        return safe
    if isinstance(value, (list, tuple)):
        safe_items = []
        for item in value:
            sanitized = _sanitize_value(item)
            if sanitized is not _DROP:
                safe_items.append(sanitized)
        return safe_items
    if isinstance(value, set):
        safe_items = []
        for item in sorted(value, key=str):
            sanitized = _sanitize_value(item)
            if sanitized is not _DROP:
                safe_items.append(sanitized)
        return safe_items

    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _sanitize_value(item())
        except (TypeError, ValueError):
            pass

    return str(value)
