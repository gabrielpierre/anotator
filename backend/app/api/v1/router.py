from fastapi import APIRouter

from app.api.v1 import (
    artifacts,
    audit,
    auth,
    cvat,
    derived_assets,
    health,
    imports,
    inference,
    jobs,
    labels,
    models,
    pipeline_definitions,
    pipelines,
    projects,
    releases,
    review,
    system,
    tasks,
    training,
    users,
)

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(cvat.router, prefix="/cvat", tags=["cvat"])
api_router.include_router(projects.router, prefix="/projects", tags=["projects"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
api_router.include_router(jobs.router, prefix="/jobs", tags=["jobs"])
api_router.include_router(inference.router, prefix="/inference-runs", tags=["inference-runs"])
api_router.include_router(labels.router, prefix="/labels", tags=["labels"])
api_router.include_router(models.router, prefix="/models", tags=["models"])
api_router.include_router(pipeline_definitions.router, prefix="/pipeline-definitions", tags=["pipeline-definitions"])
api_router.include_router(derived_assets.router, prefix="/derived-assets", tags=["derived-assets"])
api_router.include_router(review.router, prefix="/review", tags=["review"])
api_router.include_router(system.router, prefix="/system", tags=["system"])
api_router.include_router(audit.router, prefix="/audit", tags=["audit"])
api_router.include_router(artifacts.router, prefix="/artifacts", tags=["artifacts"])
api_router.include_router(imports.router, prefix="/imports", tags=["imports"])
api_router.include_router(releases.router, prefix="/dataset-releases", tags=["dataset-releases"])
api_router.include_router(training.router, prefix="/training-runs", tags=["training-runs"])
api_router.include_router(pipelines.router, prefix="/pipeline-runs", tags=["pipeline-runs"])
