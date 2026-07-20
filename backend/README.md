# Anotator Backend

FastAPI backend for the CVAT integration roadmap.

## Local services

From the project root:

```powershell
.\scripts\dev\up.ps1
```

Useful URLs:

- Frontend: http://localhost:3000
- Backend docs: http://localhost:8020/docs
- CVAT: http://localhost:8080
- MLflow: http://localhost:5000
- MinIO console: http://localhost:9001

## CVAT token

Create or copy a CVAT access token and expose it before starting the stack:

```powershell
$env:CVAT_ACCESS_TOKEN = "<token>"
.\scripts\dev\up.ps1
```

The backend talks to CVAT through REST/SDK boundaries only. It does not access the CVAT database.

## Current implementation scope

Implemented:

- Healthcheck and CORS.
- SQLAlchemy models for CVAT sync, review decisions, releases, jobs, training runs, pipeline runs and audit events.
- CVAT status and sync endpoints.
- Read APIs for projects, dashboard, tasks, jobs, labels, task data meta and task previews.
- Idempotent CVAT sync for projects, tasks, jobs, labels, data meta and backend-proxied previews.
- Review queue derived from synchronized CVAT shapes, tracks and tags.
- Review decisions with audit events and `AnnotationRevision` / `TrackRevision` records.
- Incremental CVAT annotation updates through `PATCH /api/jobs/{id}/annotations/?action=update|delete`.
- Immutable dataset releases with snapshots of CVAT tasks, jobs, labels, splits and counts.
- CVAT dataset export per task with artifacts stored in MinIO/S3.
- QA snapshot from synchronized Ground Truth jobs and CVAT quality reports when available.
- Training runs blocked unless the dataset release is ready, immutable and has exported artifacts.
- Celery/Redis-backed jobs for CVAT sync, dataset release export, training runs and pipeline runs.
- Job state machine with `queued`, `running`, `paused`, `succeeded`, `failed` and `canceled`.
- Job cancellation for non-final jobs through `POST /api/v1/jobs/{id}/cancel`.
- SSE job snapshots through `GET /api/v1/jobs/events` and `GET /api/v1/jobs/{id}/events`.
- Ultralytics inference worker for detection, segmentation, classification and tracking jobs.
- Auto-annotation suggestions stored as model layers with model/version/threshold/NMS/score/user/timestamp origin metadata.
- Safe auto-annotation policy: append by default; replace requires explicit confirmation and only removes proposed suggestions from the same model layer.
- Ultralytics training worker linked to immutable ready dataset releases.
- MLflow logging for training params, metrics and artifacts.
- Local `ModelVersion` registry tied to `TrainingRun`, `DatasetRelease` and MLflow run IDs.
- Training SSE snapshots through `GET /api/v1/training-runs/{id}/events`.
- Pipeline definitions and derived classification dataset runs.
- `DerivedAsset` records with annotation/track lineage, split, crop metadata, model metadata, score and human correction state.
- Derived dataset releases with manifest artifacts and preview assets in the artifact store.
- Optional internal API-key authentication through `INTERNAL_API_KEY`.
- User login with DB-backed opaque sessions, admin/anotador roles and project membership.
- Audit events API with pagination and CSV export.
- Backend artifact downloads/proxy URLs for releases, models and derived assets.
- YOLO dataset materialization from CVAT image exports.
- Model import, promotion and archive endpoints.
- Frontend mock fallback disabled by default; fixtures require `NEXT_PUBLIC_ENABLE_MOCK_FALLBACK=true`.
- Operational setup, backup and troubleshooting documented in `docs/setup-operacional-local.md`.
- Local project creation with storage folder and per-project quota stored in `Project.raw.storage`.

Not complete yet:

- Attribute-based review markings inside CVAT for `uncertain` / `escalated` decisions.
- Full production hardening for CVAT track split/close reconciliation; the backend records before/after locally and syncs direct updates when possible.

## Migrations and local baseline

The backend no longer uses `Base.metadata.create_all()` during startup. Run Alembic before starting the API:

```bash
cd backend
alembic upgrade head
```

The development Docker Compose stack runs this command automatically for the backend and worker. `AUTO_CREATE_TABLES=false` is the supported setting.

This repository uses a clean local baseline migration. Before applying it to an existing local database, create a backup and reset the local database if old Alembic revisions are present.

From the repository root, the supported reset helper is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/reset-local-db.ps1 -ConfirmReset
```

## User login and internal API key

On an empty migrated database, startup seeds one admin if no user exists:

- `DEFAULT_ADMIN_EMAIL` default: `admin@cvat.plus`
- `DEFAULT_ADMIN_PASSWORD` default: `admin123`
- `DEFAULT_ADMIN_NAME` default: `Administrador`

The frontend login stores the returned session token in `sessionStorage` and sends it as `Authorization: Bearer <token>`.

Set `INTERNAL_API_KEY` only for automation/dev bypass. It is not a replacement for user login/RBAC.

Accepted credentials:

- `X-API-Key: <key>`
- `Authorization: Bearer <key>`
- `?api_key=<key>` for browser-only SSE/image requests

The health endpoint and OpenAPI docs remain exempt by default.
