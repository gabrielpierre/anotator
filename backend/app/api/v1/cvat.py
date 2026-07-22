from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session
from app.core.config import get_settings
from app.models import JobRecord, User
from app.schemas import CvatStatusRead, JobRead, SyncResult
from app.services.cvat_client import CvatClient
from app.services.jobs import attach_celery_task, create_job
from app.services.sync import CvatSyncService
from app.tasks import sync_cvat_task

router = APIRouter()


@router.get("/status", response_model=CvatStatusRead)
def cvat_status(_: User = Depends(current_user)) -> CvatStatusRead:
    settings = get_settings()
    client = CvatClient(settings)
    try:
        about = client.server_about()
        authenticated = False
        if client.authenticated:
            try:
                client.current_user()
                authenticated = True
            except Exception as auth_exc:
                return CvatStatusRead(
                    configured=client.configured,
                    reachable=True,
                    base_url=settings.cvat_base_url,
                    authenticated=False,
                    version=about.get("version") or about.get("server_version"),
                    error=str(auth_exc),
                )
        return CvatStatusRead(
            configured=client.configured,
            reachable=True,
            base_url=settings.cvat_base_url,
            authenticated=authenticated,
            version=about.get("version") or about.get("server_version"),
        )
    except Exception as exc:
        return CvatStatusRead(
            configured=client.configured,
            reachable=False,
            base_url=settings.cvat_base_url,
            authenticated=client.authenticated,
            error=str(exc),
        )


@router.post("/sync", response_model=SyncResult)
def sync_cvat(
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> SyncResult:
    service = CvatSyncService(db, CvatClient(get_settings()))
    return service.sync_all()


@router.post("/sync/jobs", response_model=JobRead)
def queue_cvat_sync(
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> JobRecord:
    job = create_job(
        db,
        kind="sync",
        name="CVAT sync",
        detail="Queued CVAT synchronization.",
        raw={"operation": "cvat_sync"},
    )
    task = sync_cvat_task.delay(job.id)
    return attach_celery_task(db, job.id, task.id)
