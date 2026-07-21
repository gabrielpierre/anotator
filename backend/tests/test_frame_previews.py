import io

from PIL import Image

from app.core.config import Settings
from app.services.cvat_client import CvatBinaryResponse
from app.services.frame_previews import retrieve_annotation_frame_preview


class FakeCvatClient:
    def __init__(self, content: bytes):
        self.content = content
        self.calls = 0
        self.qualities: list[str] = []

    def retrieve_task_frame(self, task_id: str, frame: int, *, quality: str) -> CvatBinaryResponse:
        assert task_id == "task-1"
        assert frame == 3
        self.calls += 1
        self.qualities.append(quality)
        return CvatBinaryResponse(content=self.content, content_type="image/jpeg")


def test_annotation_frame_preview_resizes_and_caches(tmp_path) -> None:
    source = _jpeg(width=4000, height=3000)
    client = FakeCvatClient(source)
    settings = Settings(
        CVAT_BASE_URL="http://cvat.test",
        ANNOTATION_FRAME_MAX_SIDE=1000,
        ANNOTATION_FRAME_JPEG_QUALITY=80,
        ANNOTATION_FRAME_SOURCE_QUALITY="compressed",
        ANNOTATION_FRAME_CACHE_DIR=str(tmp_path),
    )

    first = retrieve_annotation_frame_preview(
        client=client,  # type: ignore[arg-type]
        settings=settings,
        task_id="task-1",
        frame=3,
    )
    second = retrieve_annotation_frame_preview(
        client=client,  # type: ignore[arg-type]
        settings=settings,
        task_id="task-1",
        frame=3,
    )

    assert client.calls == 1
    assert client.qualities == ["compressed"]
    assert first.source == "compressed"
    assert second.source == "cache"
    assert first.content == second.content

    with Image.open(io.BytesIO(first.content)) as image:
        assert image.width == 1000
        assert image.height == 750


def _jpeg(*, width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), color=(120, 160, 90))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()
