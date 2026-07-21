from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import AnnotationRecord, AnnotationRevision, AuditEvent, CvatLabel, ReviewDecision
from app.schemas import ReviewDecisionCreate
from app.services.annotations import apply_review_decision


class FakePatchClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    def partial_update_job_annotations(self, job_id: str, action: str, payload: dict) -> None:
        self.calls.append((job_id, action, payload))


def test_corrected_review_decision_patches_cvat_and_records_audit() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakePatchClient()

    with session_factory() as db:
        db.add(
            CvatLabel(
                external_id="task:21:label:12",
                name="bus",
                task_external_id="21",
                raw={"id": 12, "name": "bus"},
            )
        )
        db.add(
            AnnotationRecord(
                external_id="cvat_job:99:shape:501",
                cvat_job_id="99",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="501",
                frame=0,
                label_id=11,
                label_name="truck",
                shape_type="rectangle",
                source="manual",
                points=[10, 20, 110, 120],
                raw={
                    "id": 501,
                    "type": "rectangle",
                    "frame": 0,
                    "label_id": 11,
                    "points": [10, 20, 110, 120],
                    "_cvat_version": 3,
                },
            )
        )
        db.commit()

        decision = apply_review_decision(
            db,
            client,  # type: ignore[arg-type]
            ReviewDecisionCreate(
                external_annotation_id="cvat_job:99:shape:501",
                decision="corrected",
                annotation_type="shape",
                cvat_job_id="99",
                corrected_label="bus",
            ),
        )

        assert decision.cvat_synced is True
        assert decision.cvat_error is None
        assert client.calls == [
            (
                "99",
                "update",
                {
                    "version": 3,
                    "tags": [],
                    "shapes": [
                        {
                            "id": 501,
                            "type": "rectangle",
                            "frame": 0,
                            "label_id": 12,
                            "points": [10, 20, 110, 120],
                        }
                    ],
                    "tracks": [],
                },
            )
        ]
        assert db.scalar(select(AnnotationRecord)).label_name == "bus"  # type: ignore[union-attr]
        assert db.scalar(select(ReviewDecision)) is not None
        assert db.scalar(select(AnnotationRevision)) is not None
        assert db.scalar(select(AuditEvent)) is not None


def test_needs_annotation_review_decision_is_local_only() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakePatchClient()

    with session_factory() as db:
        db.add(
            AnnotationRecord(
                external_id="cvat_job:99:shape:502",
                cvat_job_id="99",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="502",
                frame=0,
                label_id=11,
                label_name="truck",
                shape_type="rectangle",
                points=[10, 20, 110, 120],
                raw={"id": 502, "type": "rectangle", "frame": 0, "label_id": 11, "points": [10, 20, 110, 120]},
            )
        )
        db.commit()

        decision = apply_review_decision(
            db,
            client,  # type: ignore[arg-type]
            ReviewDecisionCreate(
                external_annotation_id="cvat_job:99:shape:502",
                decision="needs_annotation",
                annotation_type="shape",
                cvat_job_id="99",
            ),
        )

        annotation = db.scalar(select(AnnotationRecord))
        assert annotation is not None
        assert annotation.review_state == "needs_annotation"
        assert annotation.raw["needs_annotation"] is True
        assert decision.decision == "needs_annotation"
        assert decision.cvat_synced is False
        assert client.calls == []


def test_deleted_by_reviewer_sends_complete_cvat_delete_payload() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakePatchClient()

    with session_factory() as db:
        db.add(
            AnnotationRecord(
                external_id="cvat_job:99:shape:503",
                cvat_job_id="99",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="503",
                frame=4,
                label_id=12,
                label_name="bus",
                shape_type="rectangle",
                points=[10, 20, 110, 120],
                raw={
                    "id": 503,
                    "type": "rectangle",
                    "frame": 4,
                    "label_id": 12,
                    "points": [10, 20, 110, 120],
                    "_cvat_version": 8,
                },
            )
        )
        db.commit()

        decision = apply_review_decision(
            db,
            client,  # type: ignore[arg-type]
            ReviewDecisionCreate(
                external_annotation_id="cvat_job:99:shape:503",
                decision="deleted_by_reviewer",
                annotation_type="shape",
                cvat_job_id="99",
            ),
        )

        assert decision.cvat_synced is True
        assert client.calls == [
            (
                "99",
                "delete",
                {
                    "version": 8,
                    "tags": [],
                    "shapes": [
                        {
                            "id": 503,
                            "type": "rectangle",
                            "frame": 4,
                            "label_id": 12,
                            "points": [10, 20, 110, 120],
                        }
                    ],
                    "tracks": [],
                },
            )
        ]
        assert db.scalar(select(AnnotationRecord)).review_state == "deleted_by_reviewer"  # type: ignore[union-attr]
