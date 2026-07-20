from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.schemas import DirectoryEntryRead, DirectoryListingRead

router = APIRouter()


@router.get("/directories", response_model=DirectoryListingRead)
def list_directories(path: str | None = Query(default=None, max_length=4096)) -> DirectoryListingRead:
    target = _directory_path(path)
    entries: list[DirectoryEntryRead] = []
    try:
        children = list(target.iterdir())
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied for directory") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    for child in children:
        try:
            if child.is_dir():
                entries.append(DirectoryEntryRead(name=child.name, path=str(child)))
        except OSError:
            continue

    entries.sort(key=lambda item: (item.name.startswith("."), item.name.casefold()))
    parent = str(target.parent) if target.parent != target else None
    return DirectoryListingRead(path=str(target), parent=parent, entries=entries)


def _directory_path(path: str | None) -> Path:
    raw = path.strip() if path else str(Path.home())
    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = Path.home() / target
    try:
        resolved = target.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    return resolved
