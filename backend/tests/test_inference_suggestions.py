import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.services import inference as inference_service
from app.core.config import Settings
from app.core.database import Base
from app.models import CvatLabel, InferenceSuggestion, Task
from app.schemas import InferenceRunCreate
from app.services.inference import ModelPrediction, run_inference


class FakeFrameClient:
    pass


class FakeImage:
    size = (200, 100)


def fake_predictor(image, payload: InferenceRunCreate) -> list[ModelPrediction]:
    return [
        ModelPrediction(
            label_name="car",
            score=0.91,
            shape_type="rectangle",
            points=[10, 20, 110, 80],
            raw={"bbox_norm": {"x": 0.05, "y": 0.2, "w": 0.5, "h": 0.6}},
        )
    ]


def test_inference_suggestions_preserve_origin_and_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(inference_service, "_load_task_image", lambda client, task_id, frame: FakeImage())
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add(Task(external_id="21", name="camera-01", status="annotation", size=3))
        db.add(CvatLabel(external_id="task:21:label:7", name="car", task_external_id="21", raw={"id": 7}))
        db.commit()

        suggestions = run_inference(
            db,
            payload=InferenceRunCreate(
                task_external_id="21",
                model_id="yolo11n",
                model_version="v12",
                model_family="detection",
                base_model="yolo11n.pt",
                frame_start=0,
                threshold=0.35,
                nms_iou=0.45,
                classes=["car"],
                user_id="tester",
            ),
            settings=Settings(),
            client=FakeFrameClient(),  # type: ignore[arg-type]
            predictor=fake_predictor,
        )

        assert len(suggestions) == 1
        suggestion = suggestions[0]
        assert suggestion.status == "proposed"
        assert suggestion.task_external_id == "21"
        assert suggestion.frame == 0
        assert suggestion.label_id == 7
        assert suggestion.label_name == "car"
        assert suggestion.score == 0.91
        assert suggestion.origin["model_id"] == "yolo11n"
        assert suggestion.origin["model_version"] == "v12"
        assert suggestion.origin["threshold_used"] == 0.35
        assert suggestion.origin["nms_iou"] == 0.45
        assert suggestion.origin["user_id"] == "tester"
        assert suggestion.raw["bbox_norm"]["w"] == 0.5


def test_replace_requires_confirmation_and_only_replaces_same_model_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(inference_service, "_load_task_image", lambda client, task_id, frame: FakeImage())
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add(Task(external_id="21", name="camera-01", status="annotation", size=3))
        db.add(
            InferenceSuggestion(
                external_id="old-same-model",
                task_external_id="21",
                frame=0,
                model_id="yolo11n",
                model_version="v12",
                model_family="detection",
                label_name="car",
                score=0.6,
                shape_type="rectangle",
                points=[1, 2, 3, 4],
                status="proposed",
            )
        )
        db.add(
            InferenceSuggestion(
                external_id="old-other-model",
                task_external_id="21",
                frame=0,
                model_id="yolo11m",
                model_version="v18",
                model_family="detection",
                label_name="truck",
                score=0.7,
                shape_type="rectangle",
                points=[1, 2, 3, 4],
                status="proposed",
            )
        )
        db.commit()

        with pytest.raises(ValueError):
            run_inference(
                db,
                payload=InferenceRunCreate(
                    task_external_id="21",
                    model_id="yolo11n",
                    model_version="v12",
                    apply_mode="replace",
                    confirm_replace=False,
                ),
                settings=Settings(),
                client=FakeFrameClient(),  # type: ignore[arg-type]
                predictor=fake_predictor,
            )

        run_inference(
            db,
            payload=InferenceRunCreate(
                task_external_id="21",
                model_id="yolo11n",
                model_version="v12",
                apply_mode="replace",
                confirm_replace=True,
            ),
            settings=Settings(),
            client=FakeFrameClient(),  # type: ignore[arg-type]
            predictor=fake_predictor,
        )

        assert db.scalar(select(func.count(InferenceSuggestion.id))) == 2
        assert db.scalar(select(InferenceSuggestion).where(InferenceSuggestion.external_id == "old-same-model")) is None
        assert db.scalar(select(InferenceSuggestion).where(InferenceSuggestion.external_id == "old-other-model")) is not None
