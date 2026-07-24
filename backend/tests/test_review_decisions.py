from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    CvatLabel,
    FrameWorkflowState,
    ReviewDecision,
)
from app.api.v1.review import _approved_frame_annotations, _frame_queue_annotations, _queue_frame_count
from app.services.annotations import FRAME_ANNOTATION_PENDING, FRAME_APPROVED, FRAME_REVIEW_PENDING
from app.schemas import ReviewDecisionCreate
from app.services.annotations import apply_review_decision


class FakePatchClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    def partial_update_job_annotations(self, job_id: str, action: str, payload: dict) -> None:
        self.calls.append((job_id, action, payload))


def test_review_queue_returns_all_annotations_for_reviewable_frame() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add(
            FrameWorkflowState(
                task_external_id="21",
                frame=2,
                status=FRAME_REVIEW_PENDING,
                annotation_count=2,
            )
        )
        for index, label in enumerate(("car", "person")):
            db.add(
                AnnotationRecord(
                    external_id=f"cvat_job:99:shape:{index}",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=str(index),
                    frame=2,
                    label_name=label,
                    shape_type="rectangle",
                    points=[10 + index, 20, 110 + index, 120],
                    review_state="pending",
                    raw={"type": "rectangle", "points": [10 + index, 20, 110 + index, 120]},
                )
            )
        db.commit()

        candidates = list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.external_id)).all())
        queue = _frame_queue_annotations(db, candidates)

        assert [item.label_name for item in queue] == ["car", "person"]
        assert _queue_frame_count(queue) == 1


def test_review_queue_skips_frames_sent_to_annotation() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add(
            FrameWorkflowState(
                task_external_id="21",
                frame=2,
                status=FRAME_ANNOTATION_PENDING,
                annotation_count=1,
            )
        )
        db.add(
            AnnotationRecord(
                external_id="dataset:21:shape:1",
                cvat_job_id="local:21",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="1",
                frame=2,
                label_name="car",
                shape_type="rectangle",
                source="dataset_import",
                points=[10, 20, 110, 120],
                review_state="pending",
                raw={"type": "rectangle", "points": [10, 20, 110, 120]},
            )
        )
        db.commit()

        candidates = list(db.scalars(select(AnnotationRecord)).all())

        assert _frame_queue_annotations(db, candidates) == []


def test_review_queue_deduplicates_dataset_import_and_prefers_cvat_record() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        for external_id, source in (
            ("dataset:21:shape:local-1", "dataset_import"),
            ("cvat_job:99:shape:501", "manual"),
        ):
            db.add(
                AnnotationRecord(
                    external_id=external_id,
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=external_id.rsplit(":", 1)[-1],
                    frame=4,
                    label_name="truck",
                    shape_type="rectangle",
                    source=source,
                    points=[10, 20, 110, 120],
                    review_state="pending",
                    raw={"type": "rectangle", "points": [10, 20, 110, 120]},
                )
            )
        db.commit()

        candidates = list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.external_id)).all())
        queue = _frame_queue_annotations(db, candidates)

        assert [item.external_id for item in queue] == ["cvat_job:99:shape:501"]


def test_approved_queue_returns_only_approved_frames() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add_all(
            [
                FrameWorkflowState(
                    task_external_id="21",
                    frame=2,
                    status=FRAME_APPROVED,
                    annotation_count=2,
                ),
                FrameWorkflowState(
                    task_external_id="21",
                    frame=3,
                    status=FRAME_REVIEW_PENDING,
                    annotation_count=1,
                ),
            ]
        )
        for external_id, frame, state, label, points in (
            ("cvat_job:99:shape:501", 2, "accepted", "truck", [10, 20, 110, 120]),
            ("cvat_job:99:shape:502", 2, "corrected", "car", [40, 50, 130, 150]),
            ("cvat_job:99:shape:503", 3, "accepted", "truck", [10, 20, 110, 120]),
        ):
            db.add(
                AnnotationRecord(
                    external_id=external_id,
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=external_id.rsplit(":", 1)[-1],
                    frame=frame,
                    label_name=label,
                    shape_type="rectangle",
                    points=points,
                    review_state=state,
                    raw={"type": "rectangle", "points": points},
                )
            )
        db.commit()

        candidates = list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.external_id)).all())
        queue = _approved_frame_annotations(db, candidates)

        assert [item.external_id for item in queue] == ["cvat_job:99:shape:501", "cvat_job:99:shape:502"]
        assert _queue_frame_count(queue) == 1


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


def test_accept_review_decision_approves_complete_frame() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakePatchClient()

    with session_factory() as db:
        for index in range(2):
            db.add(
                AnnotationRecord(
                    external_id=f"cvat_job:99:shape:60{index}",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=f"60{index}",
                    frame=8,
                    label_id=11,
                    label_name="truck",
                    shape_type="rectangle",
                    points=[10 + index, 20, 110, 120],
                    raw={
                        "id": 600 + index,
                        "type": "rectangle",
                        "frame": 8,
                        "label_id": 11,
                        "points": [10 + index, 20, 110, 120],
                    },
                )
            )
        db.commit()

        decision = apply_review_decision(
            db,
            client,  # type: ignore[arg-type]
            ReviewDecisionCreate(
                external_annotation_id="cvat_job:99:shape:600",
                decision="accepted",
                annotation_type="shape",
                cvat_job_id="99",
            ),
        )

        rows = list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.external_id)).all())
        assert [row.review_state for row in rows] == ["accepted", "accepted"]
        assert decision.payload["frame_annotations_accepted"] == 2
        frame_state = db.scalar(select(FrameWorkflowState))
        assert frame_state is not None
        assert frame_state.status == "approved"
        assert frame_state.annotation_count == 2


def test_needs_annotation_review_decision_returns_complete_frame_to_annotation() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakePatchClient()

    with session_factory() as db:
        for external_id, frame in (
            ("cvat_job:99:shape:701", 3),
            ("cvat_job:99:shape:702", 3),
            ("cvat_job:99:shape:703", 4),
        ):
            db.add(
                AnnotationRecord(
                    external_id=external_id,
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=external_id.rsplit(":", 1)[-1],
                    frame=frame,
                    label_id=11,
                    label_name="truck",
                    shape_type="rectangle",
                    points=[10, 20, 110, 120],
                    raw={
                        "id": external_id.rsplit(":", 1)[-1],
                        "type": "rectangle",
                        "frame": frame,
                        "label_id": 11,
                        "points": [10, 20, 110, 120],
                    },
                )
            )
        db.commit()

        decision = apply_review_decision(
            db,
            client,  # type: ignore[arg-type]
            ReviewDecisionCreate(
                external_annotation_id="cvat_job:99:shape:701",
                decision="needs_annotation",
                annotation_type="shape",
                cvat_job_id="99",
                reason="bbox ruim",
            ),
        )

        rows = {
            row.external_id: row.review_state
            for row in db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.external_id)).all()
        }
        assert rows == {
            "cvat_job:99:shape:701": "needs_annotation",
            "cvat_job:99:shape:702": "needs_annotation",
            "cvat_job:99:shape:703": "pending",
        }
        assert decision.payload["frame_annotations_sent_to_annotation"] == 2
        frame_state = db.scalar(select(FrameWorkflowState).where(FrameWorkflowState.frame == 3))
        assert frame_state is not None
        assert frame_state.status == "needs_annotation"
        assert frame_state.annotation_count == 0


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
