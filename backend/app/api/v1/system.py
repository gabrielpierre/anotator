import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, status

from app.core.config import get_settings
from app.schemas import DirectoryCreate, DirectoryEntryRead, DirectoryListingRead

router = APIRouter()


@router.get("/directories", response_model=DirectoryListingRead)
def list_directories(path: str | None = Query(default=None, max_length=4096)) -> DirectoryListingRead:
    root = _directory_root()
    target = _directory_path(path, root)
    return _directory_listing(target, root)


@router.post("/directories", response_model=DirectoryListingRead, status_code=status.HTTP_201_CREATED)
def create_directory(payload: DirectoryCreate) -> DirectoryListingRead:
    root = _directory_root()
    parent = _directory_path(payload.parent_path, root)
    name = _directory_name(payload.name)
    target = parent / name
    try:
        resolved_target = target.resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if resolved_target != root and root not in resolved_target.parents:
        raise HTTPException(status_code=403, detail="Directory is outside the configured root")
    try:
        target.mkdir()
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail="Directory already exists") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied for directory") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _inherit_owner(target, parent)
    return _directory_listing(target.resolve(), root)


def _directory_listing(target: Path, root: Path) -> DirectoryListingRead:
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
    parent = _parent_path(target, root)
    return DirectoryListingRead(path=str(target), parent=parent, entries=entries)


def _directory_root() -> Path:
    configured = get_settings().system_directory_home
    raw = configured.strip() if configured else str(Path.home())
    return _resolve_directory(raw)


def _directory_path(path: str | None, root: Path) -> Path:
    raw = path.strip() if path else str(root)
    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = root / target
    resolved = _resolve_directory(str(target))
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=403, detail="Directory is outside the configured root")
    return resolved


def _resolve_directory(raw: str) -> Path:
    try:
        resolved = Path(raw).expanduser().resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    return resolved


def _directory_name(raw: str) -> str:
    name = raw.strip()
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Directory name is invalid")
    if "/" in name or "\\" in name or "\x00" in name:
        raise HTTPException(status_code=400, detail="Directory name cannot contain path separators")
    return name


def _inherit_owner(target: Path, parent: Path) -> None:
    try:
        parent_stat = parent.stat()
        os.chown(target, parent_stat.st_uid, parent_stat.st_gid)
    except OSError:
        return


def _parent_path(target: Path, root: Path) -> str | None:
    if target == root:
        return None
    parent = target.parent
    if parent == target or (parent != root and root not in parent.parents):
        return None
    return str(parent)
