from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.core.config import Settings
from app.services.cvat_client import CvatBinaryResponse, CvatClient


@dataclass(frozen=True)
class FramePreview:
    content: bytes
    content_type: str
    source: str


def retrieve_annotation_frame_preview(
    *,
    client: CvatClient,
    settings: Settings,
    task_id: str,
    frame: int,
    max_side: int | None = None,
) -> FramePreview:
    resolved_max_side = _positive_int(max_side) or max(1, settings.annotation_frame_max_side)
    jpeg_quality = min(95, max(40, settings.annotation_frame_jpeg_quality))
    source_quality = settings.annotation_frame_source_quality.strip() or "compressed"
    cache_path = _cache_path(
        settings=settings,
        task_id=task_id,
        frame=frame,
        source_quality=source_quality,
        max_side=resolved_max_side,
        jpeg_quality=jpeg_quality,
    )

    cached = _read_cache(cache_path)
    if cached is not None:
        return FramePreview(content=cached, content_type="image/jpeg", source="cache")

    source = client.retrieve_task_frame(task_id, frame, quality=source_quality)
    content = _resize_frame(
        source=source,
        max_side=resolved_max_side,
        jpeg_quality=jpeg_quality,
    )
    _write_cache(cache_path, content)
    return FramePreview(content=content, content_type="image/jpeg", source=source_quality)


def _resize_frame(
    *,
    source: CvatBinaryResponse,
    max_side: int,
    jpeg_quality: int,
) -> bytes:
    try:
        with Image.open(io.BytesIO(source.content)) as image:
            image.load()
            frame = image.convert("RGB") if image.mode != "RGB" else image.copy()
    except UnidentifiedImageError:
        return source.content

    if max(frame.width, frame.height) > max_side:
        frame.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    frame.save(buffer, format="JPEG", quality=jpeg_quality, progressive=True)
    return buffer.getvalue()


def _cache_path(
    *,
    settings: Settings,
    task_id: str,
    frame: int,
    source_quality: str,
    max_side: int,
    jpeg_quality: int,
) -> Path:
    digest = hashlib.sha1(
        f"{task_id}:{frame}:{source_quality}:{max_side}:{jpeg_quality}".encode(),
    ).hexdigest()
    return Path(settings.annotation_frame_cache_dir) / f"{digest}.jpg"


def _read_cache(path: Path) -> bytes | None:
    try:
        if path.is_file():
            return path.read_bytes()
    except OSError:
        return None
    return None


def _write_cache(path: Path, content: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(".tmp")
        tmp_path.write_bytes(content)
        tmp_path.replace(path)
    except OSError:
        return


def _positive_int(value: int | None) -> int | None:
    if value is None or value <= 0:
        return None
    return value
