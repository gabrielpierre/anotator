from app.core.celery_app import celery_app


def test_training_tasks_route_to_dedicated_queue() -> None:
    routes = celery_app.conf.task_routes

    assert routes["app.tasks.training_run"]["queue"] == "training"
    assert celery_app.conf.task_default_queue == "celery"
